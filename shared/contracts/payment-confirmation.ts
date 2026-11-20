import { z } from "zod"

const reference = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/)
const snapshot = {
  eventId: reference,
  merchantRef: reference,
  orderRef: reference,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  amountPaise: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  currency: z.literal("INR"),
}

// Normalized synthetic observations. A future Paytm adapter has to validate and
// normalize gateway responses before they can be trusted by the payment workflow.
export const SandboxPaymentSignalSchema = z.union([
  z.object({
    ...snapshot,
    source: z.literal("gateway"),
    transactionRef: reference,
    status: z.enum(["CAPTURED", "PENDING", "FAILED"]),
  }).strict(),
  z.object({
    ...snapshot,
    source: z.literal("merchant-order"),
    status: z.literal("UNPAID"),
  }).strict(),
  z.object({
    ...snapshot,
    source: z.literal("merchant-order"),
    status: z.literal("PAID"),
    transactionRef: reference,
  }).strict(),
])

export type SandboxPaymentSignal = z.infer<typeof SandboxPaymentSignalSchema>
