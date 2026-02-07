import {
  type HardFlagRule,
  type RuleCondition,
  type InventoryCondition,
  type GateStatus,
  type RuleEvalResult,
  HARD_FLAG_RULES,
} from "./hardFlagRules";

function getNestedValue(obj: any, path: string): any {
  return path.split(".").reduce((cur, key) => cur?.[key], obj);
}

function evaluateJobCondition(cond: RuleCondition, job: Record<string, string>): boolean {
  const fieldValue = (job[cond.field] || "").toLowerCase();
  const vals = cond.values.map((v) => v.toLowerCase());

  switch (cond.operator) {
    case "contains_any":
      return vals.some((v) => fieldValue.includes(v));
    case "contains_all":
      return vals.every((v) => fieldValue.includes(v));
    case "not_contains_any":
      return !vals.some((v) => fieldValue.includes(v));
    case "equals":
      return vals.includes(fieldValue);
    case "not_equals":
      return !vals.includes(fieldValue);
    default:
      return false;
  }
}

function evaluateInventoryCondition(cond: InventoryCondition, inventory: any): boolean {
  const fieldValue = getNestedValue(inventory, cond.field);

  switch (cond.operator) {
    case "exists":
      return fieldValue !== undefined && fieldValue !== null;
    case "not_exists":
      return fieldValue === undefined || fieldValue === null;
    case "equals": {
      const target = cond.values?.[0] || "";
      return String(fieldValue) === target;
    }
    case "includes_any": {
      if (!Array.isArray(fieldValue)) return false;
      const lower = fieldValue.map((v: string) => String(v).toLowerCase());
      return (cond.values || []).some((v) => {
        const needle = v.toLowerCase();
        return lower.some((item) => item.includes(needle));
      });
    }
    case "not_includes_any": {
      if (!Array.isArray(fieldValue)) return true;
      const lower = fieldValue.map((v: string) => String(v).toLowerCase());
      return !(cond.values || []).some((v) => {
        const needle = v.toLowerCase();
        return lower.some((item) => item.includes(needle));
      });
    }
    default:
      return false;
  }
}

function combineConditions(results: boolean[], logic: "AND" | "OR"): boolean {
  if (results.length === 0) return true;
  return logic === "AND" ? results.every(Boolean) : results.some(Boolean);
}

const GATE_PRIORITY: Record<GateStatus, number> = { NO: 3, REVIEW: 2, PASS: 1 };

export function evaluateRules(
  job: { jd_raw_text?: string; title?: string; location?: string; remote_hybrid?: string },
  inventory: any,
  rules?: HardFlagRule[],
): RuleEvalResult {
  const activeRules = (rules || HARD_FLAG_RULES).filter((r) => r.enabled);

  const jobFields: Record<string, string> = {
    jd: job.jd_raw_text || "",
    title: job.title || "",
    location: job.location || "",
    remote_hybrid: job.remote_hybrid || "",
  };

  const flags: RuleEvalResult["flags"] = [];
  let worstGate: GateStatus = "PASS";
  let totalAdjustment = 0;

  for (const rule of activeRules) {
    const jobResults = rule.jobConditions.map((c) => evaluateJobCondition(c, jobFields));
    const jobPass = combineConditions(jobResults, rule.jobConditionLogic);
    if (!jobPass) continue;

    const invResults = rule.inventoryConditions.map((c) => evaluateInventoryCondition(c, inventory));
    const invPass = combineConditions(invResults, rule.inventoryConditionLogic);
    if (!invPass) continue;

    flags.push({
      ruleId: rule.id,
      ruleName: rule.name,
      message: rule.flagMessage,
    });

    totalAdjustment += rule.scoreAdjustment;

    if (GATE_PRIORITY[rule.gate] > GATE_PRIORITY[worstGate]) {
      worstGate = rule.gate;
    }
  }

  return {
    flags: flags.sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
    gateOverride: worstGate,
    scoreAdjustment: totalAdjustment,
  };
}
