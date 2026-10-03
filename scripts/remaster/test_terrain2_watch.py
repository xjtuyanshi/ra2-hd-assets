"""Asset-free restart, quota-stop and duplicate-watcher regressions."""
from pathlib import Path
import tempfile
import unittest
import terrain2_watch as watch


class WatchTests(unittest.TestCase):
    def test_restart_checks_existing_paint_and_never_accepts_it(self):
        with tempfile.TemporaryDirectory() as d:
            cache=Path(d);tile=cache/'tiles/0_0';tile.mkdir(parents=True)
            (tile/'output.png').write_bytes(b'pre-existing actual image represented by an opaque fixture')
            actions=[];phases=[]
            def run(action):
                actions.append(action)
                if action=='status':return dict(generated=1,total=1,accepted=0)
                return []
            outcome,state=watch.cycle(run,cache,phases.append)
            self.assertEqual(actions,['ingest','qa','status'])
            self.assertEqual(outcome,'awaiting_visual_review');self.assertEqual(state['accepted'],0)

    def test_failed_ingestion_cannot_publish_more_requests(self):
        with tempfile.TemporaryDirectory() as d:
            actions=[]
            def run(action):
                actions.append(action);raise RuntimeError('USAGE LIMIT receipt')
            with self.assertRaisesRegex(RuntimeError,'USAGE LIMIT'):
                watch.cycle(run,Path(d),lambda _:None)
            self.assertEqual(actions,['ingest'])

    def test_failed_tiles_need_diagnosis_instead_of_automatic_retry(self):
        with tempfile.TemporaryDirectory() as d:
            def run(action):
                if action=='status':return dict(generated=0,total=1,accepted=0)
                if action=='submit':return dict(own_pending=[],submitted=[])
                return []
            outcome,_=watch.cycle(run,Path(d),lambda _:None)
            self.assertEqual(outcome,'needs_diagnosed_repair')

    def test_second_watcher_cannot_acquire_production_lease(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'lock';handle=watch.lease(path)
            try:
                with self.assertRaisesRegex(RuntimeError,'already owns'):watch.lease(path)
            finally:handle.close()
            watch.lease(path).close()


if __name__=='__main__':unittest.main()
