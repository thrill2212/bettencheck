const BOOKING_BASE_URL = "https://booking.prenotarifugi.cai.it/backend/web";
const FRONTEND_BASE_URL = "https://www.prenotarifugi.cai.it";
const SEARCH_PAGE_URL = `${FRONTEND_BASE_URL}/cerca-e-prenota/`;
const DEFAULT_USER_AGENT =
  process.env.USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeaders({ referer = SEARCH_PAGE_URL, accept = "application/json" } = {}) {
  return {
    Accept: accept,
    Origin: FRONTEND_BASE_URL,
    Referer: referer,
    "User-Agent": DEFAULT_USER_AGENT,
    "X-Requested-With": "XMLHttpRequest",
  };
}

async function parseResponseJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON response: ${text.slice(0, 240)}`);
  }
}

export function buildDetailPageUrl(shelter) {
  const id = shelter?.id ?? shelter?.metadata?.id;
  const slug = shelter?.slug ?? shelter?.metadata?.slug;
  if (slug) {
    return `${FRONTEND_BASE_URL}/dettaglio/${slug}/?id=${id}`;
  }
  return `${FRONTEND_BASE_URL}/dettaglio/?id=${id}`;
}

export function buildMediaUrl(filePath) {
  if (!filePath) return null;
  if (/^https?:\/\//i.test(filePath)) return filePath;
  return `https://booking.prenotarifugi.cai.it${filePath}`;
}

export async function fetchJson(url, {
  searchParams,
  headers,
  maxRetries = 4,
  retryDelayMs = 1250,
  backoffFactor = 1.8,
  timeoutMs = 20000,
} = {}) {
  let attempt = 0;
  let lastError = null;

  while (attempt < maxRetries) {
    attempt += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const finalUrl = new URL(url);
      for (const [key, value] of Object.entries(searchParams ?? {})) {
        if (value === undefined || value === null || value === "") continue;
        finalUrl.searchParams.set(key, String(value));
      }

      const response = await fetch(finalUrl, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        return await parseResponseJson(response);
      }

      const payload = await response.text();
      const message = `${response.status} ${response.statusText}: ${payload.slice(0, 240)}`;
      if (response.status === 403 || response.status === 429 || response.status >= 500) {
        lastError = new Error(message);
        if (attempt < maxRetries) {
          await sleep(Math.round(retryDelayMs * Math.pow(backoffFactor, attempt - 1)));
          continue;
        }
      }
      throw new Error(message);
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt >= maxRetries) break;
      await sleep(Math.round(retryDelayMs * Math.pow(backoffFactor, attempt - 1)));
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${url}`);
}

export async function fetchShelterPage({ page = 1, rows = 100, maxRetries, retryDelayMs } = {}) {
  return fetchJson(`${BOOKING_BASE_URL}/api/1.0/it/json/get/shelter/byAttributes`, {
    searchParams: { page, rows },
    headers: buildHeaders({ referer: SEARCH_PAGE_URL }),
    maxRetries,
    retryDelayMs,
  });
}

export async function discoverAllShelters({
  rowsPerPage = 100,
  pageLimit = null,
  maxRetries = 4,
  retryDelayMs = 1250,
  log = () => {},
} = {}) {
  const firstPage = await fetchShelterPage({
    page: 1,
    rows: rowsPerPage,
    maxRetries,
    retryDelayMs,
  });
  const response = firstPage?.response ?? {};
  const totalPages = Number(response.total_pages ?? 1);
  const limitedTotalPages =
    pageLimit && Number.isFinite(Number(pageLimit))
      ? Math.min(totalPages, Number(pageLimit))
      : totalPages;

  const shelters = Array.isArray(response.results) ? [...response.results] : [];
  log(`Loaded page 1/${limitedTotalPages} (${shelters.length} shelters so far)`);

  for (let page = 2; page <= limitedTotalPages; page += 1) {
    const payload = await fetchShelterPage({
      page,
      rows: rowsPerPage,
      maxRetries,
      retryDelayMs,
    });
    const pageShelters = Array.isArray(payload?.response?.results) ? payload.response.results : [];
    shelters.push(...pageShelters);
    log(`Loaded page ${page}/${limitedTotalPages} (${shelters.length} shelters so far)`);
  }

  return {
    currentPage: Number(response.current_page ?? 1),
    rows: Number(response.rows ?? rowsPerPage),
    totalPages: limitedTotalPages,
    totalResults: Number(response.total_results ?? shelters.length),
    shelters,
  };
}

export async function fetchShelterCalendar({
  shelterId,
  slug,
  year,
  month,
  people = 1,
  maxRetries = 4,
  retryDelayMs = 1250,
}) {
  return fetchJson(`${BOOKING_BASE_URL}/api/1.0/json/get/shelter/calendar/${shelterId}`, {
    searchParams: { people, month, year },
    headers: buildHeaders({
      referer: buildDetailPageUrl({ id: shelterId, slug }),
    }),
    maxRetries,
    retryDelayMs,
  });
}

export { BOOKING_BASE_URL, FRONTEND_BASE_URL, SEARCH_PAGE_URL };
