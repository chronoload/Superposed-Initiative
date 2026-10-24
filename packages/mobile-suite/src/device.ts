import { b64url64, coreId, keyId } from "@superpose/protocol";
import { z } from "zod";

/** 设备操作集合（契约 §3.4 冻结）。 */
export const DEVICE_OPS = [
  "device.led.set",
  "device.display.write",
  "device.sensor.read",
] as const;

export type DeviceOp = (typeof DEVICE_OPS)[number];

/** 设备标识集合。 */
export const DEVICE_IDS = ["led", "display", "sensor"] as const;

export type DeviceId = (typeof DEVICE_IDS)[number];

/** 设备操作所属设备；op 与 deviceId 不匹配即执行失败。 */
export const OPS_BY_DEVICE: Record<DeviceId, readonly DeviceOp[]> = {
  led: ["device.led.set"],
  display: ["device.display.write"],
  sensor: ["device.sensor.read"],
};

/** 静态接口元数据中公开的设备描述。 */
export const DEVICE_META: Record<DeviceId, Record<string, unknown>> = {
  led: { kind: "led", writable: true, description: "指示灯" },
  display: { kind: "display", writable: true, maxChars: 200, description: "文本屏" },
  sensor: { kind: "sensor", writable: false, description: "只读传感器" },
};

export const DEVICE_REQUEST_MAX_LIFETIME_MS = 30_000;
export const DISPLAY_MAX_CHARS = 200;

/** 设备请求（契约 §3.4）。 */
export const zDeviceRequest = z.object({
  id: z.string().uuid(),
  corrId: z.string().uuid(),
  requester: z.object({
    coreId: coreId,
    sessionId: z.string().uuid(),
    keyId: keyId,
  }),
  target: z.object({ deviceId: z.enum(DEVICE_IDS) }),
  op: z.enum(DEVICE_OPS),
  args: z.record(z.unknown()),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  permissionRef: z.string().uuid(),
  sig: b64url64,
});

export type DeviceRequest = z.infer<typeof zDeviceRequest>;

/** 设备请求裁决（契约 §3.4）。 */
export const zDeviceVerdict = z.object({
  requestId: z.string().uuid(),
  ok: z.boolean(),
  reason: z.enum([
    "ok",
    "E_SIG",
    "E_STALE",
    "E_PERM_UNKNOWN",
    "E_PERM_EXPIRED",
    "E_OP_NOT_GRANTED",
    "E_POLICY",
  ]),
  checkedAt: z.number().int().positive(),
});

export type DeviceVerdict = z.infer<typeof zDeviceVerdict>;

export type SuiteStateEntry = {
  deviceId: DeviceId;
  state: Record<string, unknown>;
  observedAt: number;
};

export type DeviceRuntime = {
  snapshot(): SuiteStateEntry[];
  apply(deviceId: DeviceId, op: DeviceOp, args: unknown): void;
};

type DeviceState = {
  led: { on: boolean };
  display: { text: string };
  sensor: { reading: number };
};

function assertArgsRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("device args must be an object");
  }
  return args as Record<string, unknown>;
}

function createRuntime(): DeviceRuntime {
  const states: DeviceState = {
    led: { on: false },
    display: { text: "" },
    sensor: { reading: 0 },
  };
  const observedAt: Record<DeviceId, number> = {
    led: Date.now(),
    display: Date.now(),
    sensor: Date.now(),
  };

  return {
    snapshot(): SuiteStateEntry[] {
      return DEVICE_IDS.map((deviceId) => ({
        deviceId,
        state: { ...states[deviceId] },
        observedAt: observedAt[deviceId],
      }));
    },

    apply(deviceId: DeviceId, op: DeviceOp, args: unknown): void {
      if (!DEVICE_IDS.includes(deviceId)) throw new Error(`unknown device: ${String(deviceId)}`);
      if (!OPS_BY_DEVICE[deviceId].includes(op)) {
        throw new Error(`op ${op} does not belong to ${deviceId}`);
      }
      const record = assertArgsRecord(args);

      if (op === "device.led.set") {
        if (typeof record.on !== "boolean") throw new Error("device.led.set requires { on: boolean }");
        states.led.on = record.on;
      } else if (op === "device.display.write") {
        if (typeof record.text !== "string") throw new Error("device.display.write requires { text: string }");
        if (record.text.length > DISPLAY_MAX_CHARS) {
          throw new Error(`device.display.write text exceeds ${DISPLAY_MAX_CHARS} chars`);
        }
        states.display.text = record.text;
      } else {
        if (Object.keys(record).length > 0) throw new Error("device.sensor.read takes no args");
        states.sensor.reading = Date.now() % 10_000;
      }

      observedAt[deviceId] = Date.now();
    },
  };
}

// 设备运行态按 suiteId 隔离，供 verify 层按 ctx.suiteId 取得同一实例。
const RUNTIMES = new Map<string, DeviceRuntime>();

export function devicesFor(suiteId: string): DeviceRuntime {
  let runtime = RUNTIMES.get(suiteId);
  if (runtime === undefined) {
    runtime = createRuntime();
    RUNTIMES.set(suiteId, runtime);
  }
  return runtime;
}

export function releaseDevices(suiteId: string): void {
  RUNTIMES.delete(suiteId);
}
