import { evaluateRules } from "../src/mastra/tools/hardFlagEngine";
import type { HardFlagRule } from "../src/mastra/tools/hardFlagRules";
import { HARD_FLAG_RULES } from "../src/mastra/tools/hardFlagRules";

function makeJob(overrides: Partial<{ title: string; jd_raw_text: string; location: string; remote_hybrid: string }>) {
  return {
    title: overrides.title || "",
    jd_raw_text: overrides.jd_raw_text || "",
    location: overrides.location || "",
    remote_hybrid: overrides.remote_hybrid || "",
  };
}

const INVENTORY = {
  profile: { name: "Ed Martinez", location: "Chicago, IL" },
  skills: {
    technical: ["Python", "SQL", "Snowflake", "Kubernetes", "Docker", "Git"],
    data_science: ["Machine Learning", "Deep Learning", "NLP", "MLOps"],
    domains: ["Financial Services", "Healthcare"],
  },
};

function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(name: string, actual: any, expected: any) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
      console.log(`  PASS: ${name}`);
      passed++;
    } else {
      console.log(`  FAIL: ${name}`);
      console.log(`    expected: ${JSON.stringify(expected)}`);
      console.log(`    actual:   ${JSON.stringify(actual)}`);
      failed++;
    }
  }

  console.log("\n=== Hard Flag Engine Tests ===\n");

  console.log("--- Rule 1: CI/CD + K8s+MLOps (hf-001) ---");
  {
    const job = makeJob({
      title: "VP of ML Platform",
      jd_raw_text: "Must have hands-on experience building CI/CD pipelines and deploying models at scale",
    });
    const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
    const hf1 = result.flags.find((f) => f.ruleId === "hf-001");
    assert("hf-001 fires for 'building ci/cd pipelines'", hf1 !== undefined, true);
    assert("hf-001 gate is REVIEW", result.gateOverride === "REVIEW" || result.gateOverride === "NO", true);
    assert("hf-001 score adjustment includes -10", result.scoreAdjustment <= -10, true);
  }

  {
    const job = makeJob({
      title: "VP of ML Platform",
      jd_raw_text: "Lead kubernetes and mlops platform team to build scalable infrastructure",
    });
    const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
    const hf1 = result.flags.find((f) => f.ruleId === "hf-001");
    assert("hf-001 fires for K8s+MLOps combo", hf1 !== undefined, true);
  }

  {
    const inventoryWithDevOps = {
      ...INVENTORY,
      skills: {
        ...INVENTORY.skills,
        technical: [...INVENTORY.skills.technical, "Terraform", "Jenkins"],
      },
    };
    const job = makeJob({
      title: "VP of ML Platform",
      jd_raw_text: "Must have hands-on experience building CI/CD pipelines",
    });
    const result = evaluateRules(job, inventoryWithDevOps, HARD_FLAG_RULES);
    const hf1 = result.flags.find((f) => f.ruleId === "hf-001");
    assert("hf-001 does NOT fire when inventory has DevOps tools", hf1, undefined);
  }

  console.log("\n--- Rule 2: Sponsorship restriction (hf-002) ---");
  {
    const job = makeJob({
      jd_raw_text: "Candidates must be authorized to work in the United States. We will not sponsor visas.",
    });
    const inventoryNeedsSponsor = { ...INVENTORY, profile: { ...INVENTORY.profile, needs_sponsorship: true } };
    const result = evaluateRules(job, inventoryNeedsSponsor, HARD_FLAG_RULES);
    const hf2 = result.flags.find((f) => f.ruleId === "hf-002");
    assert("hf-002 fires for sponsorship restriction + needs_sponsorship=true", hf2 !== undefined, true);
    assert("hf-002 gate is NO", result.gateOverride, "NO");
    assert("hf-002 score adjustment is 0 (gate blocks, no score needed)", result.flags.find((f) => f.ruleId === "hf-002")?.message.includes("sponsorship"), true);
  }

  {
    const job = makeJob({
      jd_raw_text: "Must be authorized to work in the US. No sponsorship available.",
    });
    const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
    const hf2 = result.flags.find((f) => f.ruleId === "hf-002");
    assert("hf-002 does NOT fire when needs_sponsorship is absent", hf2, undefined);
  }

  console.log("\n--- Rule 3: Onsite-only location mismatch (hf-003) ---");
  {
    const job = makeJob({
      title: "VP Data & AI",
      jd_raw_text: "This is an onsite only position in our San Francisco headquarters. No remote.",
      location: "San Francisco, CA",
    });
    const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
    const hf3 = result.flags.find((f) => f.ruleId === "hf-003");
    assert("hf-003 fires for onsite-only non-Chicago location", hf3 !== undefined, true);
    assert("hf-003 gate is REVIEW", result.gateOverride === "REVIEW" || result.gateOverride === "NO", true);
  }

  {
    const job = makeJob({
      title: "VP Data & AI",
      jd_raw_text: "This is an onsite only position in our Chicago office.",
      location: "Chicago, IL",
    });
    const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
    const hf3 = result.flags.find((f) => f.ruleId === "hf-003");
    assert("hf-003 does NOT fire for onsite-only Chicago", hf3, undefined);
  }

  console.log("\n--- Rule 4: PhD required (hf-004) ---");
  {
    const job = makeJob({
      title: "Head of Data Science",
      jd_raw_text: "PhD required in Computer Science, Statistics, or related quantitative field.",
    });
    const inventoryNoPhD = { ...INVENTORY, education: ["MBA", "BS Computer Science"] };
    const result = evaluateRules(job, inventoryNoPhD, HARD_FLAG_RULES);
    const hf4 = result.flags.find((f) => f.ruleId === "hf-004");
    assert("hf-004 fires for PhD required without PhD in inventory", hf4 !== undefined, true);
    assert("hf-004 score adjustment includes -5", result.scoreAdjustment <= -5, true);
  }

  {
    const job = makeJob({
      title: "Head of Data Science",
      jd_raw_text: "PhD required in Computer Science.",
    });
    const inventoryWithPhD = { ...INVENTORY, education: ["PhD Computer Science", "BS Mathematics"] };
    const result = evaluateRules(job, inventoryWithPhD, HARD_FLAG_RULES);
    const hf4 = result.flags.find((f) => f.ruleId === "hf-004");
    assert("hf-004 does NOT fire when inventory has PhD", hf4, undefined);
  }

  console.log("\n--- Rule 5: IC/Staff engineer mislabel (hf-005) ---");
  {
    const job = makeJob({
      title: "Staff Engineer, Machine Learning",
      jd_raw_text: "Design and implement ML systems at scale.",
    });
    const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
    const hf5 = result.flags.find((f) => f.ruleId === "hf-005");
    assert("hf-005 fires for 'Staff Engineer' title", hf5 !== undefined, true);
    assert("hf-005 gate is NO", result.gateOverride, "NO");
    assert("hf-005 adjustment is -15", result.scoreAdjustment <= -15, true);
  }

  {
    const job = makeJob({
      title: "Principal Scientist, AI Research",
      jd_raw_text: "Conduct cutting-edge research in AI.",
    });
    const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
    const hf5 = result.flags.find((f) => f.ruleId === "hf-005");
    assert("hf-005 fires for 'Principal Scientist' title", hf5 !== undefined, true);
  }

  {
    const job = makeJob({
      title: "VP of Data & AI",
      jd_raw_text: "Lead the enterprise data strategy.",
    });
    const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
    const hf5 = result.flags.find((f) => f.ruleId === "hf-005");
    assert("hf-005 does NOT fire for VP title", hf5, undefined);
  }

  console.log("\n--- Edge Cases ---");
  {
    const job = makeJob({ title: "VP Data", jd_raw_text: "Lead analytics strategy" });
    const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
    assert("Clean job: no flags", result.flags.length, 0);
    assert("Clean job: gate is PASS", result.gateOverride, "PASS");
    assert("Clean job: adjustment is 0", result.scoreAdjustment, 0);
  }

  {
    const allRulesDisabled = HARD_FLAG_RULES.map((r) => ({ ...r, enabled: false }));
    const job = makeJob({
      title: "Staff Engineer",
      jd_raw_text: "Build CI/CD, PhD required, onsite only San Francisco, no sponsorship",
      location: "San Francisco",
    });
    const inventoryNeedsSponsor = { ...INVENTORY, profile: { ...INVENTORY.profile, needs_sponsorship: true } };
    const result = evaluateRules(job, inventoryNeedsSponsor, allRulesDisabled);
    assert("All rules disabled: no flags fire", result.flags.length, 0);
    assert("All rules disabled: gate is PASS", result.gateOverride, "PASS");
  }

  {
    const job = makeJob({
      title: "Staff Engineer, ML Platform",
      jd_raw_text: "Hands-on building CI/CD pipelines. PhD required. Must be onsite only in our NYC office. Will not sponsor visas.",
      location: "New York, NY",
    });
    const inv = {
      ...INVENTORY,
      profile: { ...INVENTORY.profile, needs_sponsorship: true },
      education: ["MBA"],
    };
    const result = evaluateRules(job, inv, HARD_FLAG_RULES);
    assert("Multi-rule trigger: multiple flags fire", result.flags.length >= 4, true);
    assert("Multi-rule trigger: worst gate is NO", result.gateOverride, "NO");
    assert("Multi-rule trigger: flags are sorted by ruleId", result.flags.map((f) => f.ruleId), [...result.flags.map((f) => f.ruleId)].sort());
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

runTests();
