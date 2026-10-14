import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('bundle', Path(__file__).with_name('bundle.py'))
bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle)


class BundleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        for name in bundle.RUNTIME_FILES:
            target = self.source / 'deploy/selfhost' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('services: {}\n' if name.startswith('compose') else '# example\n')
        catalog = self.source / 'deploy/selfhost/images/catalog.json'
        catalog.parent.mkdir()
        self.catalog = {'schemaVersion': 1, 'pendingServices': [],
                        'services': [{'name': name} for name in bundle.SERVICE_ENV]}
        catalog.write_text(json.dumps(self.catalog))
        self.git('init', '-q')
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-qm', 'runtime fixture')
        self.sha = self.git('rev-parse', 'HEAD').strip()
        self.image_set = {'schemaVersion': 1, 'sha': self.sha,
                          'namespace': 'ghcr.io/fixture/project',
                          'platforms': ['linux/amd64', 'linux/arm64'], 'images': []}
        for index, name in enumerate(bundle.SERVICE_ENV):
            digest = 'sha256:' + format(index, '064x')
            self.image_set['images'].append({
                'name': name, 'digest': digest,
                'reference': f'ghcr.io/fixture/project/{name}@{digest}',
                'tag': f'ghcr.io/fixture/project/{name}:{self.sha}',
            })
        self.images = self.root / 'image-set.json'
        self.images.write_text(json.dumps(self.image_set))
        self.output = self.root / 'release'

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.source), *args], check=True,
                              capture_output=True, text=True).stdout

    def build(self, **kwargs):
        return bundle.build_bundle(self.source, self.sha, self.images, self.output, **kwargs)

    def test_exact_commit_whitelist_and_immutable_output(self):
        # 工作树真值、未提交脚本修改均不能混入指定SHA的bundle。
        base = self.source / 'deploy/selfhost'
        (base / 'secrets').mkdir()
        (base / 'secrets/auth_secret').write_text('private-sentinel')
        (base / '.env').write_text('private-sentinel')
        (base / 'deploy.py').write_text('private-sentinel')
        release = self.build(compatible=['a' * 40])
        self.assertEqual(bundle.verify_bundle(self.output, self.sha), release)
        self.assertEqual(release['rollbackCompatibleWith'], ['a' * 40])
        self.assertNotIn('private-sentinel', (self.output / 'deploy.py').read_text())
        self.assertFalse((self.output / 'secrets').exists())
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.build()
        self.assertEqual(bundle.verify_bundle(self.output, self.sha), release)

    def test_incomplete_wrong_source_and_catalog_block_before_output(self):
        mutations = [lambda value: value['images'].pop(),
                     lambda value: value['images'][0].update(tag='wrong-sha'),
                     lambda value: value['images'][0].update(reference='wrong-digest'),
                     lambda value: value.update(platforms=['linux/arm64'])]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                value = copy.deepcopy(self.image_set)
                mutate(value)
                self.images.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    self.build()
                self.assertFalse(self.output.exists())
        pending = dict(self.catalog, pendingServices=['backup'])
        with self.assertRaisesRegex(ValueError, 'incomplete image catalog'):
            bundle.validate_image_set(self.image_set, self.sha, pending)

    def test_tampered_extra_and_symlink_files_rejected(self):
        self.build()
        path = self.output / 'deploy.py'
        original = path.read_bytes()
        path.write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            bundle.verify_bundle(self.output, self.sha)
        path.write_bytes(original)
        extra = self.output / '.env'
        extra.write_text('private-sentinel')
        with self.assertRaisesRegex(ValueError, 'unexpected'):
            bundle.verify_bundle(self.output, self.sha)
        extra.unlink()
        path.unlink()
        path.symlink_to(self.source / 'deploy/selfhost/deploy.py')
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            bundle.verify_bundle(self.output, self.sha)

    def test_fixture_registry_is_explicit_and_never_a_formal_release(self):
        namespace = '127.0.0.1:5000/project'
        value = copy.deepcopy(self.image_set)
        value['namespace'] = namespace
        value['platforms'] = ['linux/arm64']
        for item in value['images']:
            item.update(reference=f"{namespace}/{item['name']}@{item['digest']}",
                        tag=f"{namespace}/{item['name']}:{self.sha}")
        self.images.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'namespace'):
            self.build()
        self.build(fixture=True)
        with self.assertRaisesRegex(ValueError, 'not a published release'):
            bundle.verify_bundle(self.output, self.sha)
        release = bundle.verify_bundle(self.output, self.sha, allow_fixture=True)
        self.assertEqual(set(bundle.image_env(release)), set(bundle.SERVICE_ENV.values()))
        self.assertEqual(release['rollbackCompatibleWith'], [])

    def test_source_material_missing_does_not_replace_previous_bundle(self):
        (self.source / 'deploy/selfhost/init-server.sh').unlink()
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-qm', 'missing runtime material')
        old_sha = self.sha
        self.sha = self.git('rev-parse', 'HEAD').strip()
        value = copy.deepcopy(self.image_set)
        value['sha'] = self.sha
        for item in value['images']:
            item['tag'] = item['tag'].replace(old_sha, self.sha)
        self.images.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'missing regular runtime file'):
            self.build()
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob('.bundle-*')), [])


if __name__ == '__main__':
    unittest.main()
