export type GateStatus = "PASS" | "REVIEW" | "NO";

export interface RuleCondition {
  field: "jd" | "title" | "location" | "remote_hybrid";
  operator: "contains_any" | "contains_all" | "not_contains_any" | "equals" | "not_equals";
  values: string[];
}

export interface InventoryCondition {
  field: string;
  operator: "includes_any" | "not_includes_any" | "exists" | "not_exists" | "equals";
  values?: string[];
}

export interface HardFlagRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  jobConditions: RuleCondition[];
  jobConditionLogic: "AND" | "OR";
  inventoryConditions: InventoryCondition[];
  inventoryConditionLogic: "AND" | "OR";
  gate: GateStatus;
  scoreAdjustment: number;
  flagMessage: string;
}

export interface RuleEvalResult {
  flags: { ruleId: string; ruleName: string; message: string }[];
  gateOverride: GateStatus;
  scoreAdjustment: number;
}

export const HARD_FLAG_RULES: HardFlagRule[] = [
  {
    id: "hf-001",
    name: "Hands-on CI/CD or K8s+MLOps required",
    description: "JD requires hands-on building CI/CD pipelines OR Kubernetes+MLOps, and candidate inventory lacks MLOps/DevOps depth",
    enabled: true,
    jobConditions: [
      { field: "jd", operator: "contains_any", values: ["hands-on ci/cd", "building ci/cd pipelines", "build ci/cd"] },
      { field: "jd", operator: "contains_all", values: ["kubernetes", "mlops"] },
    ],
    jobConditionLogic: "OR",
    inventoryConditions: [
      { field: "skills.technical", operator: "not_includes_any", values: ["DevOps", "Terraform", "Jenkins", "GitHub Actions"] },
    ],
    inventoryConditionLogic: "AND",
    gate: "REVIEW",
    scoreAdjustment: -10,
    flagMessage: "Role requires hands-on CI/CD or K8s+MLOps engineering depth not demonstrated in inventory",
  },
  {
    id: "hf-002",
    name: "Sponsorship restriction",
    description: "Role has sponsorship restrictions and candidate needs sponsorship",
    enabled: true,
    jobConditions: [
      { field: "jd", operator: "contains_any", values: [
        "must be authorized to work",
        "no sponsorship",
        "not able to sponsor",
        "unable to sponsor",
        "cannot sponsor",
        "will not sponsor",
        "u.s. citizen",
        "us citizen",
        "permanent resident",
        "green card",
        "security clearance",
      ]},
    ],
    jobConditionLogic: "OR",
    inventoryConditions: [
      { field: "profile.needs_sponsorship", operator: "equals", values: ["true"] },
    ],
    inventoryConditionLogic: "AND",
    gate: "NO",
    scoreAdjustment: 0,
    flagMessage: "Role has work authorization restrictions; candidate needs sponsorship",
  },
  {
    id: "hf-003",
    name: "Onsite-only location mismatch",
    description: "Role is strictly onsite in a non-preferred location",
    enabled: true,
    jobConditions: [
      { field: "jd", operator: "contains_any", values: ["onsite only", "on-site only", "in-office only", "no remote", "must be located in", "must relocate"] },
      { field: "location", operator: "not_contains_any", values: ["chicago", "remote"] },
    ],
    jobConditionLogic: "AND",
    inventoryConditions: [],
    inventoryConditionLogic: "AND",
    gate: "REVIEW",
    scoreAdjustment: -10,
    flagMessage: "Role is onsite-only in a location that requires relocation",
  },
  {
    id: "hf-004",
    name: "PhD required",
    description: "Role explicitly requires a PhD and candidate does not have one",
    enabled: true,
    jobConditions: [
      { field: "jd", operator: "contains_any", values: ["phd required", "ph.d. required", "doctorate required", "phd in"] },
    ],
    jobConditionLogic: "OR",
    inventoryConditions: [
      { field: "education", operator: "not_includes_any", values: ["PhD", "Ph.D.", "Doctorate"] },
    ],
    inventoryConditionLogic: "AND",
    gate: "REVIEW",
    scoreAdjustment: -5,
    flagMessage: "Role requires a PhD; candidate holds MBA — may still qualify if preferred vs required",
  },
  {
    id: "hf-005",
    name: "IC/Staff engineer role mislabel",
    description: "Title signals individual contributor or staff-level engineer, not leadership",
    enabled: true,
    jobConditions: [
      { field: "title", operator: "contains_any", values: ["staff engineer", "principal engineer", "senior engineer", "software engineer", "ml engineer", "data engineer", "staff scientist", "principal scientist"] },
    ],
    jobConditionLogic: "OR",
    inventoryConditions: [],
    inventoryConditionLogic: "AND",
    gate: "NO",
    scoreAdjustment: -15,
    flagMessage: "Role is an individual contributor / staff engineer position, not a leadership role",
  },
];
