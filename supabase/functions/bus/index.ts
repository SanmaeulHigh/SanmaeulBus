// 산마을고등학교 버스 정보 — 서울 리전 중계 함수 (Supabase Edge Function)
//
// 왜 필요한가: 공공데이터포털(apis.data.go.kr)은 해외 서버의 접속에 응답하지 않아요.
// Cloudflare 무료 Worker는 한국 요청도 미국(LAX)에서 처리하는 경우가 많아 실시간 조회가 실패했어요.
// 이 함수는 앱이 ?forceFunctionRegion=ap-northeast-2 로 부르면 서울(AWS)에서 실행돼서 국내 IP로 조회합니다.
//
// 배포: Supabase 대시보드 → Edge Functions → Deploy a new function → Via Editor → 이름 "bus" → 이 코드 붙여넣기
//       → 함수 Details에서 "Verify JWT" 끄기 → Edge Functions Secrets에 DATA_GO_KR_KEY(공공데이터포털 일반 인증키) 추가
// 엔드포인트(Worker v5와 동일): /bus/health  /bus/arrive?stop=43286&route=71  /bus/buses?route=71  /bus/stops?name=산문입구
// 참고: 인천광역시 버스정보시스템 OpenAPI 매뉴얼 https://bus.incheon.go.kr/bis/openApiGuide05.view

const ROUTE_IDS: Record<string, string> = {
  "71": "169000029",
  "60-5": "165000391",
  "3000": "169000037",
  "40": "165000276", // 40(강화)
  "41": "165000277", // 41(강화)
  "45": "165000281", // 45(강화)
  "46": "169000017", // 46(강화)
};

const STOP_IDS: Record<string, string> = {
  "43286": "169000286", // 산문입구 (구래/검단 방향)
  "43107": "169000107", // 산문입구 (강화터미널 방향)
  "43599": "169000599", // 산마을고등학교 (주차장 입구)
};

const BASE = "https://apis.data.go.kr/6280000";
const PATHS: Record<string, string> = {
  arriveAll: "busArrivalService/getAllRouteBusArrivalList", // 정류소 하나에 오는 모든 노선 (매뉴얼 5번)
  arrive: "busArrivalService/getBusArrivalList",            // 정류소+노선 (매뉴얼 6번)
  loc: "busLocationService/getBusRouteLocation",            // 노선별 버스 위치 (매뉴얼 10번)
  stop: "busStationService/getBusStationNmList",            // 정류소명 검색 (매뉴얼 19번)
};
const TTL_MS: Record<string, number> = { arriveAll: 15000, arrive: 15000, loc: 15000, stop: 6 * 3600 * 1000 };
const TIMEOUT_MS = 8000;

// 매뉴얼의 OpenAPI 에러 코드
const ERROR_HINTS: Record<string, string> = {
  "1": "인천시 서버 내부 오류(APPLICATION_ERROR). 잠시 후 다시 시도해 보세요.",
  "10": "요청 파라미터 오류. 노선ID·정류소ID가 바뀌었을 수 있어요.",
  "12": "해당 API가 없거나 폐기됨(NO_OPENAPI_SERVICE).",
  "20": "서비스 접근 거부. data.go.kr에서 이 API 활용신청이 승인 상태인지 확인하세요.",
  "22": "일일 호출 한도 초과. data.go.kr 마이페이지에서 트래픽을 확인하세요.",
  "30": "등록되지 않은 서비스키. DATA_GO_KR_KEY가 data.go.kr의 '일반 인증키'와 같은지 확인하세요.",
  "31": "서비스키 기한 만료. data.go.kr에서 활용기간을 연장하세요.",
  "32": "등록되지 않은 IP.",
  "99": "기타 오류.",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-region",
};

type Up = {
  ok: boolean; http: number | null; code: string | null; msg: string | null; count: number;
  ms: number | null; items: string[]; hint: string | null; snippet: string | null; cached?: boolean;
};

const memo = new Map<string, { at?: number; value?: Up; promise?: Promise<Up> }>();
const region = () => Deno.env.get("SB_REGION") || "unknown";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/bus(?=\/|$)/i, "") || "/"; // 함수 이름을 Bus로 지어도 동작
  const key = keyParam();

  try {
    if (path === "/health" || path === "/") {
      const fresh = url.searchParams.get("fresh") === "1";
      const [stop, arrive, loc] = await Promise.all([
        upstream(key, "stop", { bstopNm: "산문입구", numOfRows: 5, pageNo: 1 }, fresh),
        upstream(key, "arriveAll", { bstopId: STOP_IDS["43286"], numOfRows: 20, pageNo: 1 }, fresh),
        upstream(key, "loc", { routeId: ROUTE_IDS["71"], numOfRows: 20, pageNo: 1 }, fresh),
      ]);
      const checks = { stop: summarize(stop), arrive: summarize(arrive), loc: summarize(loc) };
      return json({
        ok: Object.values(checks).every((c) => c.ok),
        checkedAt: new Date().toISOString(),
        region: region(),
        keyConfigured: !!key,
        checks,
        verdict: verdict(checks, !!key),
      });
    }

    if (path === "/arrive") {
      const stopKey = url.searchParams.get("stop") || "";
      const routeName = url.searchParams.get("route") || "";
      const bstopId = STOP_IDS[stopKey], routeId = ROUTE_IDS[routeName];
      if (!bstopId) return json({ error: `stop id not configured: ${stopKey}` }, 400);
      if (!routeId) return json({ error: `unknown route: ${routeName}` }, 400);
      // 정류소 단위로 한 번만 조회해서(71·60-5가 같은 호출을 공유) 노선으로 거른다
      let up = await upstream(key, "arriveAll", { bstopId, numOfRows: 30, pageNo: 1 });
      let items = up.items.filter((b) => tag(b, "ROUTEID") === routeId);
      if (!up.ok) { // 목록조회가 막히면 항목조회로 한 번 더
        up = await upstream(key, "arrive", { bstopId, routeId, numOfRows: 5, pageNo: 1 });
        items = up.items.filter((b) => !tag(b, "ROUTEID") || tag(b, "ROUTEID") === routeId);
      }
      const arrivals = items.map(arriveItem).filter((a) => Number.isFinite(a.etaSec)).sort((a, b) => a.etaSec - b.etaSec);
      return json({ stop: stopKey, bstopId, route: routeName, arrivals, upstream: meta(up), region: region() });
    }

    if (path === "/buses") {
      const routeName = url.searchParams.get("route") || "";
      const routeId = ROUTE_IDS[routeName];
      if (!routeId) return json({ error: `unknown route: ${routeName}` }, 400);
      const up = await upstream(key, "loc", { routeId, numOfRows: 30, pageNo: 1 });
      return json({ route: routeName, routeId, buses: up.items.map(locItem), upstream: meta(up), region: region() });
    }

    if (path === "/stops") {
      const name = url.searchParams.get("name") || "산문";
      const up = await upstream(key, "stop", { bstopNm: name, numOfRows: 20, pageNo: 1 });
      const stops = up.items.map((b) => ({
        bstopId: tag(b, "BSTOPID"), shortBstopId: tag(b, "SHORT_BSTOPID"), name: tag(b, "BSTOPNM"), adminNm: tag(b, "ADMINNM"),
      }));
      return json({ query: name, count: stops.length, stops, upstream: meta(up), region: region() });
    }

    return json({ error: "not found", endpoints: ["/bus/health", "/bus/arrive?stop=43286&route=71", "/bus/buses?route=71", "/bus/stops?name=산문입구"] }, 404);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

// ─── 공공데이터포털 호출: 15초 캐시 + 동시 요청 합치기 + 오류 진단 ───
function upstream(key: string, kind: string, params: Record<string, string | number>, fresh = false): Promise<Up> {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  const cacheKey = `${kind}?${qs}`;
  const ttl = TTL_MS[kind];
  const hit = memo.get(cacheKey);
  if (!fresh && hit) {
    if (hit.value && hit.at !== undefined && Date.now() - hit.at < ttl) return Promise.resolve({ ...hit.value, cached: true });
    if (hit.promise) return hit.promise;
  }
  const promise = callUpstream(key, kind, qs).then((value) => {
    memo.set(cacheKey, { at: Date.now() - (value.ok ? 0 : Math.max(0, ttl - 5000)), value }); // 오류는 5초만 기억
    if (memo.size > 300) memo.delete(memo.keys().next().value as string);
    return value;
  });
  memo.set(cacheKey, { promise });
  return promise;
}

async function callUpstream(key: string, kind: string, qs: string): Promise<Up> {
  if (!key) return fail("NO_KEY", "DATA_GO_KR_KEY 시크릿이 설정되지 않았어요.");
  const started = Date.now();
  let status = 0, body = "";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(`${BASE}/${PATHS[kind]}?serviceKey=${key}&${qs}`, { signal: ctrl.signal, headers: { Accept: "application/xml" } });
    status = res.status;
    body = await res.text();
    clearTimeout(t);
  } catch (e) {
    const timeout = (e as Error)?.name === "AbortError";
    return fail(timeout ? "TIMEOUT" : "FETCH_ERROR",
      timeout ? `공공데이터포털이 ${TIMEOUT_MS / 1000}초 안에 응답하지 않았어요.` : `연결 실패: ${(e as Error)?.message}`,
      Date.now() - started);
  }
  const items = [...body.matchAll(/<itemList>([\s\S]*?)<\/itemList>/g)].map((m) => m[1]);
  // 오류 응답: <cmmMsgHeader><errMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</errMsg><returnAuthMsg>…</returnAuthMsg><returnReasonCode>30</returnReasonCode>
  const authCode = tag(body, "returnReasonCode");
  const isError = body.includes("<cmmMsgHeader") || !!authCode;
  const resultCode = tag(body, "resultCode");
  const msg = tag(body, "returnAuthMsg") || tag(body, "errMsg") || tag(body, "resultMsg");
  const hasHeader = body.includes("<msgHeader") || body.includes("<ServiceResult");
  const ok = !isError && status === 200 && (items.length > 0 || hasHeader);
  return {
    ok, http: status, code: authCode || resultCode || null, msg: msg || null, count: items.length,
    ms: Date.now() - started, items,
    hint: ok ? null : (ERROR_HINTS[authCode] || (status !== 200 ? `HTTP ${status} 응답` : "예상과 다른 응답 형식")),
    snippet: ok ? null : redact(body.slice(0, 400), key),
  };
}

function fail(code: string, msg: string, ms: number | null = null): Up {
  return { ok: false, http: null, code, msg, count: 0, ms, items: [], hint: msg, snippet: null };
}
function meta(up: Up) {
  return { ok: up.ok, code: up.code, msg: up.msg, count: up.count, cached: !!up.cached, hint: up.hint || undefined };
}
function summarize(up: Up) {
  return { ok: up.ok, http: up.http, code: up.code, msg: up.msg, count: up.count, ms: up.ms, hint: up.hint, snippet: up.snippet };
}
function verdict(c: Record<string, ReturnType<typeof summarize>>, hasKey: boolean) {
  if (!hasKey) return "서비스키가 비어 있어요. Edge Functions → Secrets에 DATA_GO_KR_KEY를 추가하세요.";
  if (Object.values(c).every((v) => v.ok)) {
    return c.loc.count === 0 ? "API 정상. 지금은 71번 차량 위치가 0대예요(운행 시간 외일 수 있음)." : "정상 작동 중이에요.";
  }
  const names: Record<string, string> = { stop: "정류소", arrive: "도착", loc: "위치" };
  return Object.entries(c).filter(([, v]) => !v.ok).map(([k, v]) => `${names[k]} API 실패 — ${v.hint}`).join(" / ");
}

function arriveItem(b: string) {
  const raw = tag(b, "ARRIVALESTIMATETIME");
  const eta = raw === "" ? NaN : Number(raw);
  const stops = Number(tag(b, "REST_STOP_COUNT"));
  return {
    routeId: tag(b, "ROUTEID"), busId: tag(b, "BUSID"), plateNo: tag(b, "BUS_NUM_PLATE"),
    stopsBefore: Number.isFinite(stops) ? stops : null,
    etaSec: eta, etaMin: Number.isFinite(eta) ? Math.round(eta / 60) : null,
    currentStop: tag(b, "LATEST_STOP_NAME"),
    isLastBus: tag(b, "LASTBUSYN") === "1",
    lowFloor: tag(b, "LOW_TP_CD") === "1",
    congestion: congestionLabel(tag(b, "CONGESTION")),
  };
}
function locItem(b: string) {
  return {
    busId: tag(b, "BUSID"), plateNo: tag(b, "BUS_NUM_PLATE"), lowFloor: tag(b, "LOW_TP_CD") === "1",
    direction: ({ "0": "상행", "1": "하행", "2": "순환" } as Record<string, string>)[tag(b, "DIRCD")] || null,
    stopSeq: Number(tag(b, "LATEST_STOPSEQ")), stopId: tag(b, "LATEST_STOP_ID"), stopName: tag(b, "LATEST_STOP_NAME"),
    congestion: congestionLabel(tag(b, "CONGESTION")), isLastBus: tag(b, "LASTBUSYN") === "1",
  };
}
function keyParam() {
  const raw = (Deno.env.get("DATA_GO_KR_KEY") || "").trim();
  if (!raw) return "";
  return raw.includes("%") ? raw : encodeURIComponent(raw);
}
function redact(s: string, key: string) {
  let out = s;
  if (key) { out = out.split(key).join("***"); try { out = out.split(decodeURIComponent(key)).join("***"); } catch { /* */ } }
  return out.replace(/serviceKey=[^&"<\s]+/gi, "serviceKey=***");
}
function tag(xml: string, name: string) {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? m[1].trim() : "";
}
function congestionLabel(c: string) { return c === "1" ? "여유" : c === "2" ? "보통" : c === "3" ? "혼잡" : null; } // 0: 정보없음
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
