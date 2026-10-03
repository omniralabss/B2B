export const countInquiriesByProduct = (inquiries = []) => {
  const counts = new Map();

  for (const inquiry of inquiries) {
    const productId = String(inquiry?.productId || '').trim();
    if (!productId) continue;
    counts.set(productId, (counts.get(productId) || 0) + 1);
  }

  return counts;
};

export const sortHotSellingProducts = (products = [], inquiryCounts = new Map()) => {
  return [...products].sort((left, right) => {
    const leftId = String(left?._id || '');
    const rightId = String(right?._id || '');
    const leftCount = inquiryCounts.get(leftId) || 0;
    const rightCount = inquiryCounts.get(rightId) || 0;

    if (leftCount !== rightCount) return rightCount - leftCount;

    const leftDate = new Date(left?.createdAt || 0).getTime();
    const rightDate = new Date(right?.createdAt || 0).getTime();
    if (leftDate !== rightDate) return rightDate - leftDate;

    return String(rightId).localeCompare(String(leftId));
  });
};
