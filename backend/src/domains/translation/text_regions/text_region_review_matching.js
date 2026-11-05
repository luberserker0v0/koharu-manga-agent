function geometryFromRegion(region) {
  const [x, y, width, height] = region.box;
  return { x, y, width, height, rotation: 0 };
}

function mismatch(message) {
  return Object.assign(new Error(message), { statusCode: 422, code: "text_region_review_shape_mismatch" });
}

function buildReviewOperations(page, review) {
  if (review.regions.length !== page.regions.length) {
    throw mismatch("AI OCR review cannot add or remove text regions.");
  }
  return page.regions.flatMap((current, index) => {
    const reviewed = review.regions[index];
    const expected = geometryFromRegion({ box: [
      current.geometry.x, current.geometry.y, current.geometry.width, current.geometry.height,
    ] });
    const received = geometryFromRegion(reviewed);
    const geometryChanged = ["x", "y", "width", "height"]
      .some((field) => expected[field] !== received[field]);
    if (geometryChanged) throw mismatch("AI OCR review cannot change text-region geometry.");
    return current.sourceText === reviewed.text
      ? []
      : [{ type: "update", regionId: current.id, sourceText: reviewed.text }];
  });
}

module.exports = { buildReviewOperations };
