// REA-1232 browser proof. Walks landing -> Get Started -> screen 2 -> Continue ->
// step form against a LOCAL `next start`, with every /api/* request fulfilled by
// a mock here (nothing reaches a backend) and the Datadog SDK stubbed so no
// RUM data leaves the browser. Records every call the app makes on the SDK.
import { chromium } from "path_to_connect_incentives_checkout/node_modules/playwright/index.mjs"
import { mkdirSync, writeFileSync } from "node:fs"

const WT = "path_to_connect_incentives_checkout"
const BASE = "http://localhost:3232"
const OUT = `${WT}/test-results/rea-1232-proof`
const COMPANY = "proof-solar"
const REF_ID = "rea-1232-proof"
const PATH = `/${COMPANY}/refId/${REF_ID}`
mkdirSync(OUT, { recursive: true })

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (value) => Math.round(value * 10) / 10

// Replaces the SDK's methods on the object the bundle assigns to window.DD_RUM,
// which is the same object `import { datadogRum }` returns. `init` becomes a
// recorder too, so the SDK never starts and never sends anything.
const SDK_STUB = `(() => {
  const calls = [];
  Object.defineProperty(window, "__rumCalls", { value: calls });
  const copy = (value) => { try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); } };
  const trap = (globalName, sdk, methods) => {
    let api;
    Object.defineProperty(window, globalName, {
      configurable: true,
      get() { return api; },
      set(value) {
        api = value;
        if (!value) return;
        for (const method of methods) {
          if (typeof value[method] !== "function") continue;
          value[method] = (...args) => {
            calls.push({ sdk, method, at: performance.now(), args: method === "init" ? [] : copy(args) });
          };
        }
      },
    });
  };
  trap("DD_RUM", "rum", ["init", "addTiming", "addDurationVital", "addAction", "addError", "setUser",
    "startDurationVital", "stopDurationVital", "startView", "setViewName", "setViewContext", "setGlobalContextProperty",
    "startSessionReplayRecording"]);
  trap("DD_LOGS", "logs", ["init"]);
})();`

const DEVICE_UUID = "22222222-2222-4222-8222-000000000001"

function computeEnvelope() {
  return {
    compute_backend: "gcs",
    data: {
      reference_id: REF_ID,
      customer_classification: "RESIDENTIAL",
      customer_devices: [
        { device_id: "11111111-1111-4111-8111-000000000001", partner_device_reference: "9301", customer_device_id: DEVICE_UUID },
      ],
      connect_url: null,
      incentive_summary: { upfront_amount: 700, install_amount: 0, ongoing_amount: 0 },
      utilities: {
        primary: { eiaid: "14328", name: "Pacific Gas & Electric Co.", state: "CA" },
        possible_utilities: [{ eiaid: "14328", name: "Pacific Gas & Electric Co.", state: "CA" }],
      },
      partner: { name: "Proof Solar", logo_url: null },
      program_details: [
        {
          program_identifier: "pge-l2",
          name: "PG&E Residential Charging Solutions",
          display_name: "PG&E Residential Charging Solutions",
          operator_name: "PG&E",
          device_category: "EV_CHARGER",
          logo_url: null,
          terms_url: null,
          description: null,
          is_partner_offer: false,
          upfront_amount: 0,
          install_amount: 700,
          ongoing_amount: 0,
          tiers: [
            {
              tier_name: "Level 2 Charger",
              payment_type: "UPFRONT",
              incentive_amount: 700,
              device_results: [
                { partner_device_reference: "9301", customer_device_id: DEVICE_UUID, status: "COMPLETED", eligibility_details: [] },
              ],
            },
          ],
        },
      ],
      geocoding: null,
    },
  }
}

function searchApplications() {
  return {
    applications: [
      {
        id: 9101,
        program_id: 826,
        program_name: "PG&E Residential Charging Solutions",
        program_slug: "pge-l2",
        organization_id: "org_proof_solar",
        status: "not_started",
        customer_device_id: [9301],
      },
    ],
    customer: {
      id: 9201,
      first_name: "Pat",
      last_name: "Proof",
      email: "pat.proof@example.com",
      phone: "4155550100",
      eiaid: 14328,
      utility_account_number: "000011112222",
      utility_authenticated: false,
    },
    customer_devices: [
      {
        id: 9301,
        device_id: 7,
        gcs_customer_device_id: DEVICE_UUID,
        added_by: "partner",
        quantity: 1,
        device: {
          model_name: "Pulsar Plus 40A",
          model_number: "PLP1",
          manufacturer: "Wallbox",
          device_category_name: "EV Charger",
          device_subcategory: null,
        },
      },
    ],
    organization: { leap_partner_id: COMPANY },
  }
}

// app/api/fields/route.ts returns the fields object itself; the page's
// remapSleevedProgramMetadata adds the `data` wrapper.
function fields() {
  return {
    customer: {
      fields: ["customers.first_name", "customers.last_name", "customers.email", "customers.phone"],
      agreements: [],
      attachments: [],
    },
    partner: { fields: [] },
    leap: { fields: [] },
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      const response = await fetch(`${BASE}/data/components.yaml`)
      if (response.ok) return
    } catch {}
    await delay(1000)
  }
  throw new Error("local server did not start on 3232")
}

async function walk(browser, run) {
  const state = { apiCalls: [], unmockedApiCalls: [], datadogNetworkBlocked: [], appsAttempts: 0, consoleErrors: [] }
  const context = await browser.newContext({ viewport: run.viewport, colorScheme: "light", deviceScaleFactor: 1 })
  await context.addCookies([
    // lib/compute-client.ts clientComputeOverrideCookieValue: an epoch-ms deadline, at most 2 hours out.
    { name: "connect_client_compute", value: String(Date.now() + 60 * 60 * 1000), url: BASE },
  ])
  await context.addInitScript(SDK_STUB)

  await context.route(
    (url) => /datadoghq\.|browser-intake|ddog-gov\.com|datad0g/.test(url.hostname),
    (route) => {
      state.datadogNetworkBlocked.push(route.request().url())
      return route.abort()
    },
  )
  // Anything outside localhost that is not a font or script CDN is recorded, so the
  // report shows the page reached nothing else.
  await context.route(
    (url) => url.origin === BASE && url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const method = request.method()
      state.apiCalls.push(`${method} ${url.pathname}`)
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
      if (url.pathname === "/api/incentives/refresh") {
        if (run.computeDelayMs) await delay(run.computeDelayMs)
        return json(computeEnvelope())
      }
      if (url.pathname === "/api/search-applications") {
        state.appsAttempts++
        if (run.firstAppsAttempt404 && state.appsAttempts === 1) return json({ error: "not found" }, 404)
        return json(searchApplications())
      }
      if (url.pathname === "/api/fields") return json(fields())
      if (url.pathname === "/api/connect/attachments" && method === "GET") return json({ attachments: [] })
      if (url.pathname === "/api/customer-utility-credentials") return json({ credentials: {} })
      state.unmockedApiCalls.push(`${method} ${url.pathname}`)
      return json({ ok: true })
    },
  )

  const page = await context.newPage()
  page.on("console", (message) => {
    if (message.type() === "error") state.consoleErrors.push(message.text().slice(0, 300))
  })
  page.on("pageerror", (error) => state.consoleErrors.push(`pageerror: ${error.message.slice(0, 300)}`))
  state.failedResponses = []
  page.on("response", (response) => {
    if (response.status() >= 400) state.failedResponses.push(`${response.status()} ${new URL(response.url()).pathname}`)
  })

  let step = "goto"
  try {
    await page.goto(`${BASE}${PATH}`, { waitUntil: "domcontentloaded" })
    step = "landing visible"
    const getStarted = page.getByRole("button", { name: /get started/i })
    await getStarted.waitFor({ state: "visible", timeout: 30_000 })
    if (run.readLandingMs) await page.waitForTimeout(run.readLandingMs)
    step = "click get started"
    await getStarted.click()

    step = "screen 2 heading"
    await page.getByRole("heading", { name: /confirm your information/i }).waitFor({ timeout: 30_000 })
    const continueButton = page.getByRole("button", { name: /^continue$/i })
    step = "continue enabled"
    await page.waitForFunction(
      () => [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Continue" && !b.disabled),
      null,
      { timeout: 30_000 },
    )
    if (run.readScreen2Ms) await page.waitForTimeout(run.readScreen2Ms)
    step = "click continue"
    await continueButton.click()

    step = "continue vital recorded"
    await page.waitForFunction(
      () =>
        window.__rumCalls.some(
          (call) => call.method === "addDurationVital" && ["continue_to_checklist", "device_change_continue"].includes(call.args[0]),
        ),
      null,
      { timeout: 30_000 },
    )
    await page.waitForTimeout(800)
  } catch (error) {
    const diagnostics = await page
      .evaluate(() => ({
        hasStub: Array.isArray(window.__rumCalls),
        ddRumType: typeof window.DD_RUM,
        ddRumAddTimingIsStub: typeof window.DD_RUM?.addTiming === "function" && !String(window.DD_RUM.addTiming).includes("monitor"),
        calls: (window.__rumCalls || []).map((c) => ({ sdk: c.sdk, method: c.method, name: typeof c.args?.[0] === "string" ? c.args[0] : undefined, at: Math.round(c.at) })),
        text: document.body.innerText.slice(0, 1200),
        buttons: [...document.querySelectorAll("button")].map((b) => ({ text: b.textContent?.trim().slice(0, 40), disabled: b.disabled })),
      }))
      .catch((evaluateError) => ({ evaluateError: String(evaluateError) }))
    await page.screenshot({ path: `${OUT}/failure-${run.name}.png` }).catch(() => {})
    writeFileSync(`${OUT}/failure-${run.name}.json`, JSON.stringify({ step, error: String(error).slice(0, 400), diagnostics, state }, null, 2))
    await context.close()
    throw new Error(`step "${step}": ${String(error).slice(0, 200)}`)
  }
  if (run.screenshot) await page.screenshot({ path: `${OUT}/${run.screenshot}` })

  const { calls, timeOrigin } = await page.evaluate(() => ({ calls: window.__rumCalls, timeOrigin: performance.timeOrigin }))
  await context.close()

  const screenTimingCalls = calls
    .filter((call) => call.sdk === "rum" && ["addTiming", "addDurationVital"].includes(call.method))
    .map((call) =>
      call.method === "addTiming"
        ? { method: "addTiming", name: call.args[0], relativeMs: round(call.args[1] - timeOrigin), calledAtMs: round(call.at) }
        : {
            method: "addDurationVital",
            name: call.args[0],
            startRelativeMs: round(call.args[1].startTime - timeOrigin),
            durationMs: round(call.args[1].duration),
            context: call.args[1].context,
            calledAtMs: round(call.at),
          },
    )
  const actions = calls
    .filter((call) => call.sdk === "rum" && call.method === "addAction")
    .map((call) => ({ method: "addAction", name: call.args[0], context: call.args[1], calledAtMs: round(call.at) }))
  const locating = actions.filter((action) => action.name === "locating_screen_shown")
  const otherSdkCalls = calls
    .filter((call) => !(call.sdk === "rum" && ["addTiming", "addDurationVital"].includes(call.method)) && !(call.method === "addAction" && call.args[0] === "locating_screen_shown"))
    .map((call) => ({ sdk: call.sdk, method: call.method, name: typeof call.args?.[0] === "string" ? call.args[0] : undefined, calledAtMs: round(call.at) }))

  const timingAt = (name) => screenTimingCalls.find((call) => call.method === "addTiming" && call.name === name)?.relativeMs
  const count = (method, name) => screenTimingCalls.filter((call) => call.method === method && call.name === name).length
  const checks = {
    landing_content_visible_once: count("addTiming", "landing_content_visible") === 1,
    screen2_ready_once: count("addTiming", "screen2_ready") === 1,
    checklist_ready_once: count("addTiming", "checklist_ready") === 1,
    marks_in_screen_order: timingAt("landing_content_visible") <= timingAt("screen2_ready") && timingAt("screen2_ready") <= timingAt("checklist_ready"),
    get_started_to_screen2_once: count("addDurationVital", "get_started_to_screen2") === 1,
    continue_to_checklist_once: count("addDurationVital", "continue_to_checklist") === 1,
    sdk_init_stubbed: calls.some((call) => call.sdk === "rum" && call.method === "init"),
    no_datadog_network: state.datadogNetworkBlocked.length === 0,
    ...(run.expectLocating ? { locating_screen_shown_reported: locating.length > 0 } : {}),
  }

  const report = {
    run: run.name,
    viewport: run.viewport,
    url: `${BASE}${PATH}`,
    backends: "all /api/* fulfilled by mocks in this script; server compute off (CONNECT_SERVER_BOOTSTRAP_COMPUTE=off plus connect_client_compute cookie)",
    checks,
    screenTimingCalls,
    locatingActions: locating,
    otherSdkCalls,
    apiCalls: state.apiCalls,
    unmockedApiCallsAnsweredWithOk: state.unmockedApiCalls,
    datadogNetworkBlocked: state.datadogNetworkBlocked,
    failedResponses: state.failedResponses,
    consoleErrors: state.consoleErrors,
  }
  writeFileSync(`${OUT}/rum-calls-${run.name}.json`, JSON.stringify(report, null, 2))
  return report
}

await waitForServer()
const browser = await chromium.launch()
const runs = [
  { name: "400px", viewport: { width: 400, height: 860 }, screenshot: "step-form-400px.png", readLandingMs: 1500, readScreen2Ms: 1000 },
  { name: "1280px", viewport: { width: 1280, height: 900 }, screenshot: "step-form-1280px.png", readLandingMs: 1500, readScreen2Ms: 1000 },
  // The provisioning race: the first applications attempt 404s while the compute is
  // still in flight, so the locating screen shows before the landing page.
  { name: "1280px-provisioning-race", viewport: { width: 1280, height: 900 }, computeDelayMs: 2000, firstAppsAttempt404: true, expectLocating: true },
]
const only = process.argv[2]
const selectedRuns = only ? runs.filter((run) => run.name === only) : runs
const summary = []
try {
  for (const run of selectedRuns) {
    try {
      const report = await walk(browser, run)
      summary.push({ run: run.name, checks: report.checks, marks: report.screenTimingCalls.map((c) => `${c.method} ${c.name} ${c.relativeMs ?? `start ${c.startRelativeMs} dur ${c.durationMs}`}`), locating: report.locatingActions.map((a) => a.context), unmocked: report.unmockedApiCallsAnsweredWithOk, consoleErrors: report.consoleErrors.length })
    } catch (error) {
      summary.push({ run: run.name, error: String(error).slice(0, 500) })
    }
  }
} finally {
  await browser.close()
}
writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
