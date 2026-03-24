function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

export function getInfoValue(shelter, key) {
  const infos = Array.isArray(shelter?.infos) ? shelter.infos : [];
  const match = infos.find((item) => item?.key === key);
  return match?.value ?? null;
}

function getRegionValue(shelter) {
  const address = Array.isArray(shelter?.addresses) ? shelter.addresses[0] : null;
  return firstNonEmpty([
    getInfoValue(shelter, "region_geo"),
    address?.region,
    address?.country_region,
    address?.locality,
  ]);
}

function getCoords(shelter) {
  const address = Array.isArray(shelter?.addresses) ? shelter.addresses[0] : null;
  const lat = Number(address?.coords?.lat);
  const lng = Number(address?.coords?.lng);
  return {
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
  };
}

const REGION_TERMS = [
  "valle d'aosta",
  "valle daosta",
  "piemonte",
  "lombardia",
  "trentino-alto adige",
  "trentino alto adige",
  "alto adige",
  "sudtirol",
  "veneto",
  "friuli-venezia giulia",
  "friuli venezia giulia",
];

function matchesAllowedRegion(value) {
  const normalized = normalizeText(value);
  return REGION_TERMS.some((term) => normalized.includes(term));
}

function hasAlpineMassifSignal(shelter) {
  const massif = normalizeText(getInfoValue(shelter, "massif_geo"));
  return massif.includes("alpi");
}

function isWithinItalianAlpsBounds(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  return latitude >= 44.0 && latitude <= 47.25 && longitude >= 6.2 && longitude <= 13.8;
}

export function classifyShelter(shelter) {
  const region = getRegionValue(shelter);
  const massif = getInfoValue(shelter, "massif_geo");
  const valley = getInfoValue(shelter, "valley_geo");
  const municipality = getInfoValue(shelter, "municipality_geo");
  const locality = getInfoValue(shelter, "locality_geo");
  const branch = getInfoValue(shelter, "branch_cai");
  const { latitude, longitude } = getCoords(shelter);

  if (matchesAllowedRegion(region)) {
    return {
      isAlpine: true,
      reason: "region",
      region,
      massif,
      valley,
      municipality,
      locality,
      branch,
      latitude,
      longitude,
    };
  }

  if (hasAlpineMassifSignal(shelter)) {
    return {
      isAlpine: true,
      reason: "massif",
      region,
      massif,
      valley,
      municipality,
      locality,
      branch,
      latitude,
      longitude,
    };
  }

  if (!region && isWithinItalianAlpsBounds(latitude, longitude)) {
    return {
      isAlpine: true,
      reason: "coords",
      region,
      massif,
      valley,
      municipality,
      locality,
      branch,
      latitude,
      longitude,
    };
  }

  return {
    isAlpine: false,
    reason: region || massif || (latitude && longitude) ? "non-alpine" : "unclassified",
    region,
    massif,
    valley,
    municipality,
    locality,
    branch,
    latitude,
    longitude,
  };
}

export function partitionSheltersByAlpineStatus(shelters) {
  const alpine = [];
  const nonAlpine = [];
  const unclassified = [];

  for (const shelter of shelters) {
    const classification = classifyShelter(shelter);
    const enriched = { ...shelter, classification };
    if (classification.isAlpine) {
      alpine.push(enriched);
      continue;
    }
    if (classification.reason === "unclassified") {
      unclassified.push(enriched);
      continue;
    }
    nonAlpine.push(enriched);
  }

  return {
    alpine,
    nonAlpine,
    unclassified,
    summary: {
      total: shelters.length,
      alpine: alpine.length,
      nonAlpine: nonAlpine.length,
      unclassified: unclassified.length,
    },
  };
}
