const RELATIONSHIP_TERMS = [
  "\u7236\u89aa",
  "\u6bcd\u89aa",
  "\u7238\u7238",
  "\u5abd\u5abd",
  "\u54e5\u54e5",
  "\u59d0\u59d0",
  "\u5f1f\u5f1f",
  "\u59b9\u59b9",
  "\u4e08\u592b",
  "\u59bb\u5b50",
  "\u524d\u592b",
  "\u524d\u59bb",
  "\u5152\u5b50",
  "\u5973\u5152",
];

const LOCATION_SUFFIX_PATTERN =
  /(\u57ce|\u5e02|\u6751|\u93ae|\u570b|\u5e1d\u570b|\u738b\u570b|\u9818|\u5cf6|\u5c71|\u6cb3|\u6e56|\u6e2f)$/u;

const GENERIC_SOURCE_TERM_BLOCKLIST = new Set([
  "\u7570\u4e16\u754c",
  "\u8ee2\u751f",
  "\u5fa9\u8b90",
]);

const WORLDBUILDING_SUFFIX_PATTERN =
  /(\u8853|\u6cd5|\u9663|\u5f0f|\u88dd|\u6a5f|\u69cd|\u528d|\u7832|\u5f48|\u85e5|\u6bd2|\u6676|\u77f3|\u529b|\u80fd|\u6838|\u968a|\u8ecd|\u6703|\u76df|\u754c|\u56de\u8def|\u6587\u660e|\u5e1d\u56fd|\u738b\u56fd|\u56fd\u5bb6|\u7687\u56fd|\u9023\u90a6|\u5171\u548c\u56fd|\u516c\u56fd|\u738b\u671d|\u5b97\u6559|\u795e\u6bbf|\u9b54\u6cd5|\u546a\u8853|\u546a\u6cd5|\u6280\u8853|\u6587\u5316|\u6b77\u53f2|\u7a2e\u65cf|\u4e16\u754c|\u5b87\u5b99|\u9280\u6cb3|\u661f\u9593|\u6642\u4ee3)$/u;

function normalizeReferenceCategory(term, category) {
  const normalizedCategory = String(category || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const normalizedTerm = String(term || "").trim();

  if (RELATIONSHIP_TERMS.includes(normalizedTerm)) {
    return "relationship_term";
  }

  if (LOCATION_SUFFIX_PATTERN.test(normalizedTerm)) {
    return "location";
  }

  if (WORLDBUILDING_SUFFIX_PATTERN.test(normalizedTerm)) {
    return "worldbuilding";
  }

  const explicitAliasMap = {
    family: "family_name",
    family_name: "family_name",
    noble_house: "family_name",
    house: "family_name",
    clan: "family_name",
    school: "sword_school",
    sword_school: "sword_school",
    style: "sword_school",
    technique: "technique",
    move: "technique",
    skill: "technique",
    attack: "technique",
    technology: "device",
    tech: "device",
    machine: "device",
    gadget: "device",
    device: "device",
    item: "device",
    artifact: "device",
    faction: "organization",
    group: "organization",
    organization: "organization",
    institution: "organization",
    location: "location",
    place: "location",
    worldbuilding: "worldbuilding",
    setting: "worldbuilding",
    concept: "worldbuilding",
    relationship_term: "relationship_term",
    character: "character_name",
    character_name: "character_name",
    person: "character_name",
    general_term: "general_term",
  };

  if (explicitAliasMap[normalizedCategory]) {
    return explicitAliasMap[normalizedCategory];
  }

  return "general_term";
}

function isLikelyOriginalTranslatorLabel(label) {
  const normalized = String(label || "").trim().toLowerCase();
  return ["\u539f\u6587", "original", "source"].includes(normalized);
}

function isBlockedGenericSourceTerm(entry) {
  const value = String(entry?.source_term || entry?.term || entry?.translation || "").trim();
  return Boolean(value) && GENERIC_SOURCE_TERM_BLOCKLIST.has(value);
}

module.exports = {
  isBlockedGenericSourceTerm,
  isLikelyOriginalTranslatorLabel,
  normalizeReferenceCategory,
};
