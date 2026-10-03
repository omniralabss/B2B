import test from 'node:test';
import assert from 'node:assert/strict';

import { sortHotSellingProducts, countInquiriesByProduct } from '../src/productRanking.js';

test('sortHotSellingProducts ranks by inquiry count descending', () => {
  const products = [
    { _id: 'p1', name: 'A' },
    { _id: 'p2', name: 'B' },
    { _id: 'p3', name: 'C' },
  ];

  const inquiryMap = new Map([
    ['p1', 3],
    ['p2', 9],
    ['p3', 2],
  ]);

  const sorted = sortHotSellingProducts(products, inquiryMap);
  assert.deepEqual(sorted.map((product) => product._id), ['p2', 'p1', 'p3']);
});

test('countInquiriesByProduct aggregates different product ids and ignores blanks', () => {
  const inquiries = [
    { productId: 'p1' },
    { productId: 'p2' },
    { productId: 'p2' },
    { productId: '' },
    { productId: 'p1' },
    { productId: 'p9' },
  ];

  assert.deepEqual(countInquiriesByProduct(inquiries), new Map([
    ['p1', 2],
    ['p2', 2],
    ['p9', 1],
  ]));
});
