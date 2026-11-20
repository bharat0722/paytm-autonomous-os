// Detection job catalogue. Each job runs on a cron schedule and, when it fires, ingests one
// dataset of merchant signals. Incident types, thresholds and descriptions live here so the
// API can explain what was detected, by which job, and under which rule.
import type { Scenario } from "../../shared/contracts/http.js"

export interface DeviceCohort {
  model: string; affectedConfig: string; fixedConfig: string; signature: string
  targetRefs: string[]; needsRestartRefs: string[]; partialFailRef: string
  outOfWindowRefs: string[]; otherSignature: { refs: string[]; signature: string }; otherConfig: { refs: string[]; signature: string }
  ticketMerchants: string[]; ticketSubject: string; ticketCategory: string
}

export interface DetectionJob {
  id: string
  /** Batch key stored per generation (keeps one ingestion per job per generation). */
  batchKey: string
  scenario: Scenario
  name: string
  cron: string
  scheduleLabel: string
  incidentType: string
  typeLabel: string
  description: string
  threshold: string
  zone: string
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
  supportsPartial: boolean
  cohort?: DeviceCohort
}

const range = (a: number, b: number, step = 1) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step)
const ref = (n: number) => `M${String(n).padStart(3, "0")}`
const dev = (n: number, k = 1) => `D-${ref(n)}-${k}`

export const DETECTION_JOBS: readonly DetectionJob[] = Object.freeze([
  {
    id: "voice-alert-sweep", batchKey: "soundbox", scenario: "soundbox",
    name: "Payment voice-alert health sweep", cron: "*/15 * * * *", scheduleLabel: "Every 15 minutes",
    incidentType: "DEVICE_ALERT_OUTAGE", typeLabel: "Soundbox voice-alert outage",
    description: "Soundboxes stopped announcing successful payments. Money reached the merchant, but the audio confirmation did not play, so shopkeepers cannot confirm customer payments at the counter.",
    threshold: "≥ 3 merchants · same model + config + error code · within 5 minutes",
    zone: "North-1", severity: "HIGH", supportsPartial: true,
    cohort: {
      model: "SBX-AI-2", affectedConfig: "7.4.1", fixedConfig: "7.4.2", signature: "NOTIFY_PUSH_DROPPED",
      targetRefs: [...range(1, 21).map((n) => dev(n)), ...range(1, 3).map((n) => dev(n, 2))],
      needsRestartRefs: ["D-M005-1", "D-M011-1", "D-M017-1", "D-M002-2"], partialFailRef: "D-M011-1",
      outOfWindowRefs: ["D-M022-1", "D-M023-1"],
      otherSignature: { refs: ["D-M070-1", "D-M071-1"], signature: "NOTIFY_TIMEOUT" },
      otherConfig: { refs: ["D-M050-1", "D-M051-1"], signature: "AUDIO_DRIVER_ERR" },
      ticketMerchants: ["M002", "M004", "M005", "M008", "M011", "M013", "M016", "M019", "M021"],
      ticketSubject: "Payment received but Soundbox did not announce", ticketCategory: "SOUNDBOX_SILENT"
    }
  },
  {
    id: "audio-codec-monitor", batchKey: "soundbox:audio-codec-monitor", scenario: "soundbox",
    name: "Speaker & audio-codec monitor", cron: "5,35 * * * *", scheduleLabel: "Twice an hour (:05, :35)",
    incidentType: "DEVICE_AUDIO_FAULT", typeLabel: "Soundbox speaker / audio-codec fault",
    description: "SBX-LITE devices on config 3.1 report audio-codec faults. Announcements are distorted or silent after a power cycle, and merchants raise 'speaker not working' complaints.",
    threshold: "≥ 3 merchants · same model + config + error code · within 5 minutes",
    zone: "West-2", severity: "MEDIUM", supportsPartial: true,
    cohort: {
      model: "SBX-LITE", affectedConfig: "3.1", fixedConfig: "3.1.2", signature: "AUDIO_CODEC_FAULT",
      targetRefs: range(61, 91, 2).map((n) => dev(n)),
      needsRestartRefs: ["D-M065-1", "D-M077-1", "D-M089-1"], partialFailRef: "D-M077-1",
      outOfWindowRefs: ["D-M093-1", "D-M095-1"],
      otherSignature: { refs: ["D-M062-1", "D-M064-1"], signature: "LOW_BATTERY" },
      otherConfig: { refs: ["D-M066-1", "D-M068-1"], signature: "AUDIO_CODEC_FAULT" },
      ticketMerchants: ["M063", "M069", "M075", "M081", "M087"],
      ticketSubject: "Speaker crackles and then goes silent", ticketCategory: "SOUNDBOX_AUDIO"
    }
  },
  {
    id: "connectivity-monitor", batchKey: "soundbox:connectivity-monitor", scenario: "soundbox",
    name: "SIM & connectivity monitor", cron: "*/10 * * * *", scheduleLabel: "Every 10 minutes",
    incidentType: "DEVICE_CONNECTIVITY_LOSS", typeLabel: "Soundbox SIM / network dropout",
    description: "SBX-AI-2 devices on config 7.4.2 keep dropping their SIM data session. Payment events reach the device late or not at all, so alerts arrive minutes after the customer has left.",
    threshold: "≥ 3 merchants · same model + config + error code · within 5 minutes",
    zone: "East-3", severity: "HIGH", supportsPartial: true,
    cohort: {
      model: "SBX-AI-2", affectedConfig: "7.4.2", fixedConfig: "7.4.3", signature: "NET_SIM_DROPOUT",
      targetRefs: range(24, 35).map((n) => dev(n)),
      needsRestartRefs: ["D-M027-1", "D-M033-1"], partialFailRef: "D-M033-1",
      outOfWindowRefs: ["D-M036-1", "D-M037-1"],
      otherSignature: { refs: ["D-M038-1", "D-M039-1"], signature: "NOTIFY_TIMEOUT" },
      otherConfig: { refs: ["D-M052-1", "D-M053-1"], signature: "HEARTBEAT_LATE" },
      ticketMerchants: ["M025", "M029", "M031", "M034"],
      ticketSubject: "Payment alert comes 5-10 minutes late", ticketCategory: "SOUNDBOX_DELAY"
    }
  },
  {
    id: "support-dedupe", batchKey: "duplicate-tickets", scenario: "duplicate-tickets",
    name: "Support queue de-duplication", cron: "0 * * * *", scheduleLabel: "Hourly at :00",
    incidentType: "DUPLICATE_COMPLAINTS", typeLabel: "Repeated merchant complaints",
    description: "Several merchants raised the same settlement query more than once. Each repeat creates separate work for support agents and inflates queue size.",
    threshold: "≥ 3 merchants · same category + subject · within 5 minutes",
    zone: "All zones", severity: "LOW", supportsPartial: false
  },
  {
    id: "settlement-recon", batchKey: "settlement-discrepancy", scenario: "settlement-discrepancy",
    name: "Daily settlement reconciliation", cron: "30 6 * * *", scheduleLabel: "Daily at 06:30 IST",
    incidentType: "SETTLEMENT_SHORTFALL", typeLabel: "Settlement shortfall",
    description: "Merchants in one bank settlement batch were credited less than expected. Money movement is human-led: the system only investigates and hands over the facts.",
    threshold: "≥ 3 merchants · same bank batch with SHORT status",
    zone: "All zones", severity: "MEDIUM", supportsPartial: false
  }
])

export const jobById = (id: string) => DETECTION_JOBS.find((j) => j.id === id)
export const jobByBatchKey = (key: string) => DETECTION_JOBS.find((j) => j.batchKey === key)
export const defaultJobFor = (scenario: Scenario) => DETECTION_JOBS.find((j) => j.scenario === scenario)!

// ---------- Minimal cron evaluation (minute and hour fields) in IST ----------
const IST_OFFSET_MS = 330 * 60_000
function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true
  return field.split(",").some((part) => {
    const step = part.match(/^\*\/(\d+)$/)
    if (step) return value % Number(step[1]) === 0
    return Number(part) === value
  })
}
function cronMatches(cron: string, istDate: Date): boolean {
  const [minute = "*", hour = "*"] = cron.split(/\s+/)
  return fieldMatches(minute, istDate.getUTCMinutes()) && fieldMatches(hour, istDate.getUTCHours())
}
/** Next and previous fire times (UTC ISO) around `nowIso`, evaluated in IST. */
export function cronWindow(cron: string, nowIso: string): { previous: string; next: string } {
  const now = Date.parse(nowIso)
  const start = Math.floor(now / 60_000) * 60_000
  let next = start + 60_000
  for (let i = 0; i < 2 * 24 * 60 && !cronMatches(cron, new Date(next + IST_OFFSET_MS)); i++) next += 60_000
  let prev = start
  for (let i = 0; i < 2 * 24 * 60 && !cronMatches(cron, new Date(prev + IST_OFFSET_MS)); i++) prev -= 60_000
  return { previous: new Date(prev).toISOString(), next: new Date(next).toISOString() }
}
