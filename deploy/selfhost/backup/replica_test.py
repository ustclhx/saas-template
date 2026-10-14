import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.parse import urlsplit

import backup
import replica
from walg import BackupError

WAL = '000000010000000000000001'
BASE = 'base_' + WAL
INVENTORY = {'preserveFromWal': WAL, 'retained': [BASE], 'latest': BASE,
             'oldest': BASE, 'clusterId': '12345', 'timeline': 1}
VERIFICATION = {'ok': True, 'lastWal': WAL, 'continuousUntil': '2026-10-14T00:00:00Z'}


class Store:
    def __init__(self, prefix, data=None):
        self.endpoint = urlsplit('https://fixture.invalid')
        self.bucket = 'fixture'
        self.prefix = prefix
        self.data = data or {}
        self.fail = None
        self.corrupt = False

    def list(self):
        return {key: len(value) for key, value in self.data.items() if key.startswith(replica.LAYOUT)}

    def get(self, key, output=None):
        value = self.data.get(key)
        if value is None:
            return None
        if output:
            output.write(value)
        return {'bytes': len(value), 'sha256': hashlib.sha256(value).hexdigest()}

    def put(self, key, stream, record):
        if self.fail == key:
            raise BackupError('REPLICA_S3_REQUEST_FAILED')
        stream.seek(0)
        self.data[key] = b'corrupt' if self.corrupt else stream.read()


class ReplicaTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.source = Store('source/', {
            'basebackups_005/' + BASE + '/tar_partitions/part_001.tar.lz4': b'compressed-tar',
            'basebackups_005/' + BASE + '_backup_stop_sentinel.json': b'sentinel',
            'wal_005/' + WAL + '.lz4': b'compressed-wal',
            'wal_005/00000002.history.lz4': b'compressed-history',
            'logical/id/manifest.json': b'logical-manifest',
            'logical/id/roles.sql.lz4': b'roles-material',
            'logical/id/database.dump.lz4': b'dump-material'})
        self.target = Store('replica/')

    def sync(self):
        return replica.sync(INVENTORY, VERIFICATION, self.temporary.name,
                            self.source, self.target)

    def test_raw_repeat_and_source_delete_keep_independent_complete_inventory(self):
        first = self.sync()
        self.assertEqual(first['copiedObjects'], len(self.source.data))
        self.assertEqual(self.sync()['copiedObjects'], 0)
        removed = 'logical/id/database.dump.lz4'
        original = self.source.data.pop(removed)
        self.sync()
        self.assertEqual(self.target.data[removed], original)
        manifest = json.loads(self.target.data[replica.MANIFEST])
        objects = {item['key']: item for item in manifest['objects']}
        self.assertEqual(objects[removed]['sha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(len(objects), len(self.target.data) - 1)
        self.assertEqual(manifest['continuousUntil'], VERIFICATION['continuousUntil'])

    def test_interrupted_sync_never_commits_manifest_and_can_resume(self):
        self.sync()
        previous = self.target.data[replica.MANIFEST]
        key = 'logical/new/roles.sql.lz4'
        self.source.data[key] = b'new-material'
        self.target.fail = key
        with self.assertRaises(BackupError):
            self.sync()
        self.assertEqual(self.target.data[replica.MANIFEST], previous)
        self.target.fail = None
        self.assertEqual(self.sync()['copiedObjects'], 1)

    def test_corrupt_upload_or_missing_segment_refuses_manifest(self):
        self.target.corrupt = True
        with self.assertRaisesRegex(BackupError, 'CHECKSUM_MISMATCH'):
            self.sync()
        self.assertNotIn(replica.MANIFEST, self.target.data)
        self.target.corrupt = False
        self.source.data.pop('wal_005/' + WAL + '.lz4')
        with self.assertRaisesRegex(BackupError, 'WAL_GAP'):
            self.sync()
        self.assertNotIn(replica.MANIFEST, self.target.data)

    def test_download_applies_configured_body_transfer_budget(self):
        client = object.__new__(replica.S3)
        client.rate, client.chunk = 2, 2
        response = io.BytesIO(b'abcd')
        response.getheader = lambda name: '4'
        client.request = lambda *args: (MagicMock(), response)
        with patch.object(replica.time, 'monotonic', return_value=0), patch.object(replica.time, 'sleep') as sleep:
            record = client.get('wal_005/' + WAL + '.lz4')
        self.assertEqual(record['bytes'], 4)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])

    def test_independent_credentials_do_not_fallback_and_failed_operation_is_visible(self):
        with patch.dict(os.environ, {'BACKUP_S3_ACCESS_KEY_ID_FILE': '/source-access'}, clear=True):
            with self.assertRaises(BackupError):
                replica.configuration(True)
        with patch.object(backup, 'STATE', Path(self.temporary.name)):
            backup.save({'replica': {'configured': True, 'ok': True, 'lastSuccess': 'old-success'}})
            def failed():
                raise BackupError('REPLICA_S3_REQUEST_FAILED')
            with self.assertRaises(BackupError):
                backup.operation('replica', failed)
            state = backup.load()['replica']
            self.assertFalse(state['ok'])
            self.assertEqual(state['failures'], 1)
            self.assertEqual(state['lastSuccess'], 'old-success')


if __name__ == '__main__':
    unittest.main()
