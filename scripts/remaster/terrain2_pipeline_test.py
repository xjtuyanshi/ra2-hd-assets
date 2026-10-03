"""Broker lifecycle regression: incomplete receipts never free concurrency slots."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('pipeline',Path(__file__).with_name('terrain2_pipeline.py'))
pipeline=importlib.util.module_from_spec(spec);spec.loader.exec_module(pipeline)

class BrokerLifecycleTests(unittest.TestCase):
    def test_pending_counts_queued_and_running_but_not_other_tasks_or_receipts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            for name in ['task1-queued','task1-running','task1-exited','task2-running']:
                pipeline.write(root/(name+'.json'),{'task_id':name.split('-')[0]})
            pipeline.write(root/'task1-running.receipt.json',{'state':'running'})
            pipeline.write(root/'task1-exited.receipt.json',{'state':'exited','exit_code':0})
            pipeline.write(root/'task2-running.receipt.json',{'state':'running'})
            self.assertEqual(set(pipeline.own_pending(root)),{'task1-queued','task1-running'})
    def test_unknown_receipt_state_holds_slot_and_rejection_releases_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);pipeline.write(root/'task1-job.json',{})
            pipeline.write(root/'task1-job.receipt.json',{'state':'unknown'})
            self.assertEqual(pipeline.own_pending(root),['task1-job'])
            pipeline.write(root/'task1-job.receipt.json',{'state':'rejected'})
            self.assertEqual(pipeline.own_pending(root),[])
    def test_finalization_refuses_numeric_only_or_changed_image_evidence(self):
        import hashlib
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);tile=root/'tiles/0_0';tile.mkdir(parents=True)
            (root/'tiles/queue.txt').write_text(str(tile)+'\n')
            (tile/'output.png').write_bytes(b'actual producer file')
            (tile/'conditioned.png').write_bytes(b'actual conditioned file')
            report={'numerical_pass':True,'accepted':False,'raw_sha256':hashlib.sha256((tile/'output.png').read_bytes()).hexdigest()}
            pipeline.write(tile/'qa.json',report)
            with self.assertRaises(ValueError):pipeline.validated_tiles(root)
            report['accepted']=True;pipeline.write(tile/'qa.json',report)
            self.assertEqual(pipeline.validated_tiles(root),[tile])
            (tile/'output.png').write_bytes(b'changed after review')
            with self.assertRaises(ValueError):pipeline.validated_tiles(root)

    def test_atomic_request_has_exact_payload_and_leaves_no_temporary_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);payload={'task_id':'task1','job_dir':'/owned/job','prompt_file':'/owned/job/prompt.txt'}
            pipeline.write(root/'task1-job.json',payload)
            self.assertEqual(pipeline.read(root/'task1-job.json'),payload)
            self.assertEqual([p.name for p in root.iterdir()],['task1-job.json'])
if __name__=='__main__':unittest.main()
