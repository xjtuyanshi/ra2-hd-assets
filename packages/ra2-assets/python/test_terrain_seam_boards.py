"""Asset-free evidence-preservation regressions for overlap review boards."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
from PIL import Image
import terrain_seam_boards as tool


class SeamBoardsTest(unittest.TestCase):
    def test_all_wide_end_overlaps_are_preserved_at_exact_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); image_path = root/'image.png'; plan_path = root/'plan.json'
            yy,xx = np.indices((100,200)); pixels = np.stack([xx,yy,(xx+yy)%255],axis=-1).astype('uint8')
            Image.fromarray(pixels).save(image_path)
            pairs = [{'tiles':['left','right'],'axis':'vertical','overlap_box_2x':[10,0,180,100]},
                     {'tiles':['top','bottom'],'axis':'horizontal','overlap_box_2x':[0,10,200,90]}]
            plan_path.write_text(json.dumps({'pairs':pairs}))
            result = tool.generate(image_path,plan_path,root/'boards',64)
            self.assertEqual(result['pair_count'],2)
            self.assertEqual(result['image_sha256'],hashlib.sha256(image_path.read_bytes()).hexdigest())
            for record in result['records']:
                x0,y0,x1,y1 = record['box_2x']; bx,by = record['board_position']
                with Image.open(root/'boards'/record['file']) as board:
                    crop = np.asarray(board)[by+24:by+24+y1-y0,bx:bx+x1-x0]
                np.testing.assert_array_equal(crop,pixels[y0:y1,x0:x1])
            with self.assertRaises(FileExistsError):tool.generate(image_path,plan_path,root/'boards')

    def test_invalid_overlap_cannot_create_review_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); image=root/'image.png'; plan=root/'plan.json'
            Image.new('RGB',(100,100)).save(image)
            plan.write_text(json.dumps({'pairs':[{'axis':'vertical','tiles':['a','b'],'overlap_box_2x':[10,0,101,100]}]}))
            with self.assertRaises(ValueError):tool.generate(image,plan,root/'boards')
            self.assertFalse((root/'boards').exists())


if __name__ == '__main__':unittest.main()
