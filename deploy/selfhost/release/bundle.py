#!/usr/bin/env python3
"""Read immutable Git runtime materials; verify image-only bundles using stdlib."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

SHA = re.compile(r'^[a-f0-9]{40}$')
DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')
NAMESPACE = re.compile(r'^ghcr\.io/[a-z0-9]+(?:[._-][a-z0-9]+)*/[a-z0-9]+(?:[._-][a-z0-9]+)*$')
SERVICE_ENV = {
    'web': 'WEB_IMAGE', 'jobs': 'JOBS_IMAGE', 'migrate': 'MIGRATE_IMAGE',
    'postgres': 'POSTGRES_IMAGE', 'valkey': 'VALKEY_IMAGE', 'caddy': 'CADDY_IMAGE',
    'object-storage': 'OBJECT_STORAGE_IMAGE', 'backup': 'BACKUP_IMAGE',
}
# 固定运行清单，不能把源码、构建材料或工作树中的secret递归打进包。
RUNTIME_FILES = (
    'compose.yaml', 'compose.backup.yaml', 'compose.object-storage.yaml',
    'compose.proxy.yaml', '.env.example', 'secrets.example',
    'Caddyfile.object-storage', 'object-storage-init.mjs',
    'deploy.sh', 'deploy.py', 'health.py', 'init-server.sh', 'init-server.py', 'init-firewall.sh',
    'release/bundle.py', 'README.md', 'OPERATIONS.md',
)
GENERATED_FILES = ('image-set.json', 'image-catalog.json', 'images.env')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_image_set(image_set, sha, catalog, fixture=False):
    require(bool(SHA.fullmatch(sha)), 'expected full lowercase source SHA')
    require(image_set.get('schemaVersion') == 1 and image_set.get('sha') == sha,
            'image-set source SHA/schema mismatch')
    namespace = image_set.get('namespace', '')
    require(isinstance(namespace, str) and (bool(NAMESPACE.fullmatch(namespace)) or
            (fixture and re.fullmatch(r'(?:localhost|127\.0\.0\.1):[0-9]{1,5}/[a-z0-9][a-z0-9._-]*', namespace))),
            'invalid image namespace')
    platforms = image_set.get('platforms', [])
    require(isinstance(platforms, list) and len(set(platforms)) == len(platforms) and
            (sorted(platforms) == ['linux/amd64', 'linux/arm64'] or
             (fixture and platforms in [['linux/amd64'], ['linux/arm64']])),
            'published releases require two platforms; fixtures must name their actual platform')
    require(catalog.get('schemaVersion') == 1 and catalog.get('pendingServices', []) == [],
            'incomplete image catalog')
    names = [item['name'] for item in catalog['services']]
    require(len(names) == len(set(names)) and set(names) == set(SERVICE_ENV),
            'runtime catalog must contain every supported service exactly once')
    images = image_set.get('images', [])
    require(isinstance(images, list) and len(images) == len(names), 'incomplete image-set')
    result = {}
    for item in images:
        name, digest = item.get('name'), item.get('digest', '')
        require(name in names and name not in result, 'duplicate or unknown image service')
        require(isinstance(digest, str) and bool(DIGEST.fullmatch(digest)), 'invalid image digest')
        reference = f'{namespace}/{name}@{digest}'
        require(item.get('reference') == reference and item.get('tag') == f'{namespace}/{name}:{sha}',
                'image reference/tag source mismatch')
        result[name] = reference
    require(set(result) == set(names), 'missing service digest')
    return result


def image_env(release):
    return {SERVICE_ENV[name]: reference for name, reference in release['images'].items()}


def env_text(release):
    return ''.join(f'{key}={value}\n' for key, value in sorted(image_env(release).items()))


def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_bundle(directory, expected_sha, allow_fixture=False):
    directory = Path(directory)
    require(directory.is_dir() and not directory.is_symlink(), 'bundle directory required')
    require(bool(SHA.fullmatch(expected_sha)), 'expected full lowercase source SHA')
    actual = set()
    for path in directory.rglob('*'):
        require(not path.is_symlink(), 'bundle symlinks are forbidden')
        require(path.is_file() or path.is_dir(), 'bundle special files are forbidden')
        if path.is_file():
            actual.add(path.relative_to(directory).as_posix())
    expected = set(RUNTIME_FILES) | set(GENERATED_FILES) | {'release.json'}
    require(actual == expected, 'bundle contains missing or unexpected runtime files')
    release = json.loads((directory / 'release.json').read_text())
    require(release.get('schemaVersion') == 1 and release.get('sha') == expected_sha,
            'release source SHA/schema mismatch')
    require(release.get('fixture') is False or (release.get('fixture') is True and allow_fixture),
            'local fixture is not a published release')
    compatibility = release.get('rollbackCompatibleWith')
    require(isinstance(compatibility, list) and len(compatibility) == len(set(compatibility))
            and all(isinstance(value, str) and SHA.fullmatch(value) for value in compatibility),
            'invalid explicit rollback compatibility declaration')
    files = release.get('files', {})
    require(isinstance(files, dict) and set(files) == expected - {'release.json'},
            'checksum manifest must cover the exact runtime file list')
    for name, digest in files.items():
        require(isinstance(digest, str) and re.fullmatch(r'[a-f0-9]{64}', digest)
                and checksum(directory / name) == digest, 'bundle file checksum mismatch: ' + name)
    catalog = json.loads((directory / 'image-catalog.json').read_text())
    image_set = json.loads((directory / 'image-set.json').read_text())
    images = validate_image_set(image_set, expected_sha, catalog, release['fixture'])
    require(release.get('images') == images, 'release image-set mismatch')
    require((directory / 'images.env').read_text() == env_text(release), 'image env mismatch')
    example = (directory / '.env.example').read_text()
    for key, value in image_env(release).items():
        require(re.findall(r'^' + key + r'=(.*)$', example, re.M) == [value],
                'example image reference mismatch')
    for name in RUNTIME_FILES:
        if name.startswith('compose') and name.endswith('.yaml'):
            require(not re.search(r'^\s*build\s*:', (directory / name).read_text(), re.M),
                    'server-side builds are forbidden')
    return release


def git_file(source, sha, path):
    # git object只接受regular blob；同SHA的symlink不能冒充运行文件。
    full_path = 'deploy/selfhost/' + path
    entry = subprocess.run(['git', '-C', str(source), 'ls-tree', sha, '--', full_path],
                           check=True, capture_output=True).stdout.decode().split()
    require(len(entry) >= 4 and entry[0] in ('100644', '100755') and entry[1] == 'blob',
            'source SHA missing regular runtime file: ' + path)
    result = subprocess.run(['git', '-C', str(source), 'show', sha + ':' + full_path],
                            check=True, capture_output=True)
    return result.stdout, int(entry[0], 8) & 0o777


def build_bundle(source, sha, image_set_path, output, compatible=(), fixture=False):
    require(bool(SHA.fullmatch(sha)), 'expected full lowercase source SHA')
    source, output = Path(source), Path(output)
    require(not output.exists(), 'immutable bundle output already exists')
    # cat-file拒绝tree/tag等对象；部署材料必须有同一完整commit身份。
    kind = subprocess.run(['git', '-C', str(source), 'cat-file', '-t', sha],
                          check=True, capture_output=True).stdout.decode().strip()
    require(kind == 'commit', 'source SHA must be a commit')
    catalog = json.loads(git_file(source, sha, 'images/catalog.json')[0])
    image_set = json.loads(Path(image_set_path).read_text())
    images = validate_image_set(image_set, sha, catalog, fixture)
    require(all(SHA.fullmatch(value) for value in compatible) and len(set(compatible)) == len(compatible),
            'compatibility values must be distinct full source SHAs')
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.bundle-', dir=output.parent))
    try:
        for name in RUNTIME_FILES:
            data, mode = git_file(source, sha, name)
            target = temporary / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(mode)
        release = {'schemaVersion': 1, 'sha': sha, 'fixture': fixture, 'images': images,
                   'rollbackCompatibleWith': list(compatible)}
        example = (temporary / '.env.example').read_text()
        for key, value in image_env(release).items():
            pattern = r'^' + key + r'=.*$'
            if re.search(pattern, example, re.M):
                example = re.sub(pattern, key + '=' + value, example, flags=re.M)
            else:
                example += '\n' + key + '=' + value + '\n'
        (temporary / '.env.example').write_text(example)
        (temporary / 'images.env').write_text(env_text(release))
        for name, value in [('image-set.json', image_set), ('image-catalog.json', {
                'schemaVersion': 1, 'pendingServices': [],
                'services': [{'name': name} for name in images]})]:
            (temporary / name).write_text(json.dumps(value, indent=2) + '\n')
        release['files'] = {name: checksum(temporary / name)
                            for name in sorted(set(RUNTIME_FILES) | set(GENERATED_FILES))}
        (temporary / 'release.json').write_text(json.dumps(release, indent=2) + '\n')
        verify_bundle(temporary, sha, allow_fixture=fixture)
        # 不改已有版本，也不在失败时留下半成品供部署使用。
        os.rename(temporary, output)
        return release
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def compose_config(directory, sha, allow_fixture=False):
    release = verify_bundle(directory, sha, allow_fixture)
    directory = Path(directory).resolve()
    # Compose优先读取process env，清掉全部业务变量以免外部值污染digest。
    clean_env = {key: value for key, value in os.environ.items()
                 if key in ('PATH', 'HOME', 'DOCKER_CONFIG', 'DOCKER_HOST', 'DOCKER_CONTEXT')}
    args = ['docker', 'compose', '--project-directory', str(directory),
            '--env-file', str(directory / '.env.example'),
            '--env-file', str(directory / 'images.env'), '-f', str(directory / 'compose.yaml'),
            'config', '--format', 'json']
    result = subprocess.run(args, env=clean_env, capture_output=True, timeout=30)
    require(result.returncode == 0, 'clean-directory Compose config failed')
    config = json.loads(result.stdout)
    for name, service in config['services'].items():
        require('build' not in service and service.get('image') == release['images'][name],
                'Compose image differs from bundle')
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    build = commands.add_parser('build')
    build.add_argument('--source', required=True)
    build.add_argument('--sha', required=True)
    build.add_argument('--image-set', required=True)
    build.add_argument('--output', required=True)
    build.add_argument('--rollback-compatible-with', action='append', default=[])
    build.add_argument('--fixture', action='store_true')
    for name in ('verify', 'compose-config'):
        sub = commands.add_parser(name)
        sub.add_argument('directory')
        sub.add_argument('--sha', required=True)
        sub.add_argument('--allow-fixture', action='store_true')
    args = parser.parse_args()
    try:
        if args.command == 'build':
            release = build_bundle(args.source, args.sha, args.image_set, args.output,
                                   args.rollback_compatible_with, args.fixture)
        else:
            release = verify_bundle(args.directory, args.sha, args.allow_fixture)
            if args.command == 'compose-config':
                compose_config(args.directory, args.sha, args.allow_fixture)
        print(json.dumps({'sha': release['sha'], 'fixture': release['fixture'],
                          'services': sorted(release['images'])}))
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        # 不打印子进程stdout/stderr或JSON正文，避免把外部文件真值放进日志。
        parser.exit(1, 'release bundle rejected: ' + (str(error) if isinstance(error, ValueError)
                                                     else type(error).__name__) + '\n')


if __name__ == '__main__':
    main()
