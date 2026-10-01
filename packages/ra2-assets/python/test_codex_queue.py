"""Asset-free contracts of the Codex job queue; run with unittest discovery."""
from pathlib import Path
import tempfile
import unittest

from codex_queue import command, done, limit_text, live_jobs, pending, read_queue, ready


class CodexQueueTests(unittest.TestCase):
    def test_queue_order_dependencies_and_attempts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            a, b, c = root / 'a', root / 'b', root / 'c'
            for job in (a, b, c):
                job.mkdir()
            queue = root / 'queue.txt'
            queue.write_text(f'{a}\n# comment\n\n{b}\n{c}\n')
            jobs = read_queue(queue)
            self.assertEqual(jobs, [a, b, c])
            (b / 'needs').write_text(f'{a}\n')
            self.assertFalse(ready(b))
            (a / 'output.png').write_bytes(b'png')
            self.assertTrue(done(a) and ready(b))
            self.assertEqual(pending(jobs, {b}, {}), [c])
            self.assertEqual(pending(jobs, set(), {c: 3}), [b])

    def test_limit_detection_only_on_error_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            self.assertIsNone(limit_text(job))
            (job / 'run.log').write_text('thinking about rate limits of the API\n')
            self.assertIsNone(limit_text(job))
            (job / 'run.log').write_text('ERROR: You\'ve hit your usage limit. Try again later.\n')
            self.assertIn('usage limit', limit_text(job))

    def test_live_jobs_count_only_owned_exec_processes(self):
        ps = '\n'.join([
            '/x/codex exec -s workspace-write -C /work/units/inf/a -o /work/units/inf/a/last.txt prompt',
            '/x/codex exec -s workspace-write -C /work/other/b -o x prompt',
            '/x/codex exec-server -C /work/units/inf/c',
        ])
        count, jobs = live_jobs('/work/units', ps)
        self.assertEqual(count, 1)
        self.assertEqual(jobs, {Path('/work/units/inf/a')})

    def test_command_carries_model_and_effort(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            (job / 'prompt.txt').write_text('draw')
            args = command(job, 'm1', 'xhigh', codex='codex')
            self.assertEqual(args[:2], ['codex', 'exec'])
            self.assertIn('-m', args)
            self.assertEqual(args[args.index('-m') + 1], 'm1')
            self.assertIn('model_reasoning_effort="xhigh"', args)
            self.assertEqual(args[-1], 'draw')
            self.assertNotIn('-m', command(job, None, 'high', codex='codex'))


if __name__ == '__main__':
    unittest.main()
