import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, generateText } from "ai";
import { query } from "./db";

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

const ROLE_PRIORITY: Record<string, number> = {
  hiring_manager: 1,
  department_head: 2,
  recruiter: 3,
  team_lead: 4,
  hr_contact: 5,
  executive_sponsor: 6,
  peer: 7,
};

const OutreachTargetSchema = z.object({
  person_name: z
    .string()
    .describe(
      "Full name of the person if found via public sources, or empty string if suggesting a role to search for",
    ),
  title: z
    .string()
    .describe(
      "The person's actual title if known, or the recommended title to search for",
    ),
  role_category: z
    .enum([
      "hiring_manager",
      "department_head",
      "recruiter",
      "team_lead",
      "hr_contact",
      "executive_sponsor",
      "peer",
    ])
    .describe("Classification of this contact's role relative to the opening"),
  rationale: z
    .string()
    .describe(
      "Why this person/role is a valuable outreach target for this specific job",
    ),
  linkedin_url: z
    .string()
    .optional()
    .describe(
      "LinkedIn profile URL ONLY if found via public company pages, press releases, or official sources. Never fabricate.",
    ),
  source: z
    .string()
    .describe(
      "Where this information was found: company_website, press_release, public_directory, news_article, job_posting, inferred_from_structure, or web_search",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Confidence that this is the right person/role: 1.0 = named person confirmed, 0.5 = role exists but person unknown, 0.3 = inferred from company structure",
    ),
  search_query: z
    .string()
    .describe(
      "A recommended LinkedIn/Google search query the user can use to find or verify this contact",
    ),
  outreach_angle: z
    .string()
    .describe(
      "Suggested talking point or angle for initial outreach based on what was found",
    ),
});

const ContactDiscoveryOutputSchema = z.object({
  targets: z
    .array(OutreachTargetSchema)
    .describe("Ranked list of outreach targets, best first"),
  company_context: z.object({
    company_name: z.string(),
    industry: z.string().optional(),
    company_size: z.string().optional(),
    headquarters: z.string().optional(),
    recent_news: z
      .string()
      .optional()
      .describe(
        "Any recent relevant news about the company (funding, growth, leadership changes)",
      ),
    org_structure_notes: z
      .string()
      .optional()
      .describe("Notes about the company's organizational structure if found"),
  }),
  discovery_method: z
    .string()
    .describe(
      "Summary of methods used: web_search, company_website, press_releases, etc.",
    ),
  compliance_note: z
    .string()
    .describe(
      "Statement confirming no ToS violations: no scraping, no unauthorized access",
    ),
  none_found_fallback: z
    .object({
      recommended_search_queries: z
        .array(z.string())
        .describe("Google/LinkedIn search queries to try manually"),
      suggested_titles: z
        .array(z.string())
        .describe("Job titles to look for at this company"),
      alternative_channels: z
        .array(z.string())
        .describe(
          "Other channels to try: company careers page, industry events, alumni networks",
        ),
    })
    .optional()
    .describe("Populated when no specific contacts were found"),
});

export const contactDiscoveryTool = createTool({
  id: "discover-contacts",
  description:
    "Discovers compliant outreach targets for a job opportunity using web search on public sources (company websites, press releases, news articles). Never scrapes LinkedIn or violates platform ToS. Ranks contacts by relevance and saves to the contacts table. Includes 'none found' fallback with manual search suggestions.",
  inputSchema: z.object({
    job_id: z.number().describe("Database job ID to associate contacts with"),
    company_name: z.string().describe("Company name to search for contacts"),
    job_title: z
      .string()
      .describe("The job title being applied to (helps identify hiring chain)"),
    location: z
      .string()
      .optional()
      .describe("Job location to narrow search scope"),
    target_function: z
      .string()
      .optional()
      .describe(
        "Department or function (e.g., Data & Analytics, Engineering, Product)",
      ),
  }),
  outputSchema: z.object({
    targets_found: z.number(),
    targets_saved: z.number(),
    targets: z.array(OutreachTargetSchema),
    company_context: z.object({
      company_name: z.string(),
      industry: z.string().optional(),
      company_size: z.string().optional(),
      headquarters: z.string().optional(),
      recent_news: z.string().optional(),
      org_structure_notes: z.string().optional(),
    }),
    discovery_method: z.string(),
    compliance_note: z.string(),
    none_found_fallback: z
      .object({
        recommended_search_queries: z.array(z.string()),
        suggested_titles: z.array(z.string()),
        alternative_channels: z.array(z.string()),
      })
      .optional(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(
      `🔍 [discoverContacts] Starting compliant contact discovery for ${context.company_name} — "${context.job_title}"`,
    );
    logger?.info(
      `📍 [discoverContacts] Location: ${context.location || "not specified"}, Function: ${context.target_function || "not specified"}`,
    );

    const functionHint = context.target_function || inferFunction(context.job_title);
    logger?.info(`🎯 [discoverContacts] Inferred function: ${functionHint}`);

    const hiringChain = buildHiringChain(context.job_title, functionHint);
    logger?.info(
      `📊 [discoverContacts] Hiring chain titles to search: ${hiringChain.join(", ")}`,
    );

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(
      context.company_name,
      context.job_title,
      context.location,
      functionHint,
      hiringChain,
    );

    logger?.info(
      `🌐 [discoverContacts] Step 1: Web search for public contact information...`,
    );

    let webSearchResults = "";
    try {
      const searchQueries = buildWebSearchQueries(context.company_name, functionHint, hiringChain);
      logger?.info(
        `🔍 [discoverContacts] Running ${searchQueries.length} web searches...`,
      );

      const searchPrompt = searchQueries
        .map((q: string, i: number) => `Search ${i + 1}: ${q}`)
        .join("\n");

      const { text: searchText } = await generateText({
        model: openai("gpt-4o"),
        tools: {
          webSearch: openai.tools.webSearchPreview(),
        },
        maxSteps: 5,
        system: `You are a research assistant finding public information about people at a company. Use web search to find:
1. Leadership/team pages on the company website
2. Press releases mentioning executives
3. Conference speakers or blog authors from the company
4. News articles about leadership changes
5. Job posting details mentioning the hiring manager

IMPORTANT: Only report information you actually find via web search. Never fabricate names, titles, or URLs. If you cannot find specific people, say "No specific contacts found" and describe what public information is available about the company structure.`,
        prompt: `Search for outreach contacts at ${context.company_name} for a "${context.job_title}" position in the ${functionHint} department.${context.location ? ` Location: ${context.location}.` : ""}

Run these searches and compile the results:
${searchPrompt}

For each person found, note:
- Full name and title (only from verified public sources)
- Where you found the information (URL or source)
- Any LinkedIn URL ONLY if it appeared in the public source (never construct URLs)

Compile all findings into a detailed summary.`,
        temperature: 0.2,
      });

      webSearchResults = searchText;
      logger?.info(
        `✅ [discoverContacts] Web search complete (${webSearchResults.length} chars of results)`,
      );
      logger?.info(
        `📝 [discoverContacts] Web search summary preview: ${webSearchResults.substring(0, 300)}...`,
      );
    } catch (err) {
      logger?.warn(
        `⚠️ [discoverContacts] Web search failed, proceeding with structural inference: ${err}`,
      );
      webSearchResults =
        "Web search was unavailable. No specific contacts found. Proceeding with organizational structure inference only.";
    }

    logger?.info(
      `🤖 [discoverContacts] Step 2: Structuring contact information from web search results...`,
    );

    let discoveryResult;
    try {
      const structuringPrompt = `${userPrompt}

## WEB SEARCH RESULTS (use ONLY these facts — do not invent additional contacts)
${webSearchResults}

CRITICAL: Your output must ONLY include people and information that appear in the web search results above. If the web search found no named contacts, set person_name to "" and provide role-based suggestions instead. NEVER fabricate names or URLs that do not appear in the search results.`;

      const { object } = await generateObject({
        model: openai("gpt-4o"),
        schema: ContactDiscoveryOutputSchema,
        system: systemPrompt,
        prompt: structuringPrompt,
        temperature: 0.3,
      });
      discoveryResult = object;
      logger?.info(
        `✅ [discoverContacts] Structured ${discoveryResult.targets.length} potential targets from web search data`,
      );
    } catch (err) {
      logger?.error(`❌ [discoverContacts] Structuring LLM call failed: ${err}`);
      return buildEmptyResult(context.company_name, context.job_title, functionHint, hiringChain);
    }

    const rankedTargets = rankTargets(discoveryResult.targets);
    logger?.info(
      `📊 [discoverContacts] Ranked ${rankedTargets.length} targets by relevance`,
    );

    const hasNamedContacts = rankedTargets.some(
      (t) => t.person_name && t.person_name.length > 0 && t.confidence >= 0.5,
    );
    logger?.info(
      `👤 [discoverContacts] Named contacts found: ${hasNamedContacts}`,
    );

    let noneFallback = discoveryResult.none_found_fallback;
    if (!hasNamedContacts && !noneFallback) {
      logger?.info(
        `⚠️ [discoverContacts] No named contacts found, building fallback suggestions`,
      );
      noneFallback = buildNoneFoundFallback(
        context.company_name,
        context.job_title,
        functionHint,
        hiringChain,
      );
    }

    let savedCount = 0;
    for (let i = 0; i < rankedTargets.length; i++) {
      const target = rankedTargets[i];
      try {
        await query(
          `INSERT INTO contacts (job_id, person_name, title, linkedin_url, email, rank, rationale, message_draft)
           VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [
            context.job_id,
            target.person_name || `[Search: ${target.title}]`,
            target.title,
            target.linkedin_url || null,
            i + 1,
            target.rationale,
            target.outreach_angle,
          ],
        );
        savedCount++;
        logger?.info(
          `💾 [discoverContacts] Saved contact #${i + 1}: ${target.person_name || target.title} (${target.role_category})`,
        );
      } catch (err) {
        logger?.warn(
          `⚠️ [discoverContacts] Failed to save contact ${target.person_name || target.title}: ${err}`,
        );
      }
    }

    logger?.info(
      `✅ [discoverContacts] Complete: ${rankedTargets.length} targets found, ${savedCount} saved to DB`,
    );
    logger?.info(
      `📝 [discoverContacts] Compliance: ${discoveryResult.compliance_note}`,
    );

    return {
      targets_found: rankedTargets.length,
      targets_saved: savedCount,
      targets: rankedTargets,
      company_context: discoveryResult.company_context,
      discovery_method: discoveryResult.discovery_method,
      compliance_note: discoveryResult.compliance_note,
      none_found_fallback: noneFallback,
    };
  },
});

export function inferFunction(jobTitle: string): string {
  const lower = jobTitle.toLowerCase();
  const functionMap: Array<[RegExp, string]> = [
    [/\b(ai|machine learning|ml\b|research)\b/i, "AI / ML"],
    [/\b(security|infosec|cyber|ciso)\b/i, "Security"],
    [/\b(data|analytics|bi|business intelligence)\b/i, "Data & Analytics"],
    [/\b(marketing|growth|brand|content)\b/i, "Marketing"],
    [/\b(engineer|software|developer|sre|devops|platform)\b/i, "Engineering"],
    [/\b(product|pm)\b/i, "Product"],
    [/\b(design|ux|ui)\b/i, "Design"],
    [/\b(sales|account|revenue|business dev)\b/i, "Sales"],
    [/\b(finance|accounting|fp&a|cfo)\b/i, "Finance"],
    [/\b(hr|people|talent|recruiting)\b/i, "People / HR"],
    [/\b(ops|operations|strategy|chief of staff)\b/i, "Operations"],
    [/\b(legal|compliance|counsel)\b/i, "Legal"],
  ];

  for (const [pattern, fn] of functionMap) {
    if (pattern.test(lower)) return fn;
  }
  return "General Management";
}

export function buildHiringChain(jobTitle: string, targetFunction: string): string[] {
  const lower = jobTitle.toLowerCase();

  const isExec =
    /\b(vp|vice president|svp|evp|chief|cxo|head of|director)\b/.test(lower);
  const isMgr = /\b(manager|lead|principal|senior)\b/.test(lower);

  const chain: string[] = [];

  if (isExec) {
    chain.push(
      `C-suite / CEO at the company`,
      `SVP or EVP of ${targetFunction}`,
      `VP of ${targetFunction}`,
      `Head of Talent / Executive Recruiter`,
    );
  } else if (isMgr) {
    chain.push(
      `VP of ${targetFunction}`,
      `Director of ${targetFunction}`,
      `Senior Manager, ${targetFunction}`,
      `Recruiter specializing in ${targetFunction}`,
    );
  } else {
    chain.push(
      `Director of ${targetFunction}`,
      `Manager of ${targetFunction}`,
      `Team Lead, ${targetFunction}`,
      `Recruiter`,
    );
  }

  chain.push(`HR Business Partner`);

  return chain;
}

function buildSystemPrompt(): string {
  return `You are a compliant contact discovery assistant. Your job is to identify the best outreach targets for a job application at a specific company.

## COMPLIANCE RULES — NON-NEGOTIABLE
1. You MUST only use publicly available information: company websites, press releases, news articles, public directories, and web search results.
2. You MUST NOT scrape LinkedIn, bypass any authentication walls, or access any data behind login screens.
3. You MUST NOT fabricate or invent contact names, titles, or URLs. If you cannot find a specific person, say so explicitly and suggest the role title to search for instead.
4. If you find a LinkedIn URL through a public source (company about page, news article, speaker bio), you may include it. But NEVER construct LinkedIn URLs by guessing username patterns.
5. Set confidence appropriately:
   - 1.0: Named person found in public source with title confirmed
   - 0.7-0.9: Named person found but title may have changed
   - 0.5: Role likely exists based on company size/structure but person unknown
   - 0.3: Inferred from typical org structure, no confirming evidence

## SEARCH STRATEGY
1. First look for the company's leadership/team page
2. Search for recent press releases, conference speakers, blog authors from the company
3. Look for the company on Crunchbase, Glassdoor (public pages only), or news articles
4. Check if the job posting itself names a hiring manager or recruiter
5. Infer likely org structure based on company size and industry

## RANKING CRITERIA (in priority order)
1. Hiring manager (person who would directly manage this role) — highest value
2. Department head (leader of the function this role reports into)
3. Internal recruiter handling this role
4. Team lead or peer in the same function
5. HR contact or talent acquisition partner
6. Executive sponsor (C-suite over the function)

## OUTPUT QUALITY
- Every target MUST have a concrete search_query the user can run on LinkedIn or Google
- Every target MUST have an outreach_angle suggesting what to mention in initial contact
- If you find NO named contacts at all, populate none_found_fallback with actionable search queries and alternative channels
- Do NOT pad results with low-quality guesses — prefer 2-3 high-quality targets over 7 weak ones`;
}

function buildUserPrompt(
  companyName: string,
  jobTitle: string,
  location: string | undefined,
  targetFunction: string,
  hiringChain: string[],
): string {
  return `Find outreach targets for the following job application:

**Company:** ${companyName}
**Job Title:** ${jobTitle}
**Location:** ${location || "Not specified"}
**Target Function/Department:** ${targetFunction}

**Hiring chain titles to prioritize (in order):**
${hiringChain.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Search for people at ${companyName} who hold these or similar titles. Use web search to check the company's about/team page, recent press releases, conference appearances, and news articles.

For each person you find, provide:
- Their name and title (only if confirmed from a public source)
- Why they are relevant to this specific role
- A LinkedIn search query the user can use to find/verify them
- A suggested outreach angle

If you cannot find specific people, suggest the role titles to search for and provide detailed search queries.

Remember: NEVER fabricate names or URLs. When uncertain, set person_name to "" and provide the suggested title instead.`;
}

export function buildWebSearchQueries(
  companyName: string,
  targetFunction: string,
  hiringChain: string[],
): string[] {
  const cleanCompany = companyName.replace(/['"]/g, "");
  const queries: string[] = [];

  queries.push(`${cleanCompany} leadership team about page`);
  queries.push(`${cleanCompany} ${targetFunction} head OR VP OR director`);
  queries.push(`${cleanCompany} recruiter OR talent acquisition ${targetFunction}`);

  if (hiringChain.length > 0) {
    const topTitle = hiringChain[0].replace(/\bat the company\b/i, "").trim();
    queries.push(`${cleanCompany} "${topTitle}"`);
  }

  queries.push(`${cleanCompany} press release leadership OR executive 2025 OR 2026`);

  return queries;
}

export function rankTargets(
  targets: z.infer<typeof OutreachTargetSchema>[],
): z.infer<typeof OutreachTargetSchema>[] {
  return [...targets].sort((a, b) => {
    const priorityA = ROLE_PRIORITY[a.role_category] ?? 99;
    const priorityB = ROLE_PRIORITY[b.role_category] ?? 99;
    if (priorityA !== priorityB) return priorityA - priorityB;

    if (b.confidence !== a.confidence) return b.confidence - a.confidence;

    const hasNameA = a.person_name && a.person_name.length > 0 ? 0 : 1;
    const hasNameB = b.person_name && b.person_name.length > 0 ? 0 : 1;
    return hasNameA - hasNameB;
  });
}

export function buildNoneFoundFallback(
  companyName: string,
  jobTitle: string,
  targetFunction: string,
  hiringChain: string[],
): {
  recommended_search_queries: string[];
  suggested_titles: string[];
  alternative_channels: string[];
} {
  const cleanCompany = companyName.replace(/['"]/g, "");

  return {
    recommended_search_queries: [
      `"${cleanCompany}" "${targetFunction}" site:linkedin.com/in`,
      `"${cleanCompany}" recruiter "${targetFunction}" site:linkedin.com/in`,
      `"${cleanCompany}" "hiring manager" "${jobTitle}"`,
      `"${cleanCompany}" "head of" OR "VP" OR "director" "${targetFunction}"`,
      `"${cleanCompany}" team leadership page`,
    ],
    suggested_titles: hiringChain,
    alternative_channels: [
      `${cleanCompany} careers page — check for recruiter contact info`,
      `${cleanCompany} LinkedIn company page — browse "People" tab`,
      `Industry meetups/conferences in ${targetFunction} — check speaker lists`,
      `Alumni networks — search for connections at ${cleanCompany}`,
      `${cleanCompany} engineering/company blog — find authors in ${targetFunction}`,
    ],
  };
}

function buildEmptyResult(
  companyName: string,
  jobTitle: string,
  targetFunction: string,
  hiringChain: string[],
) {
  return {
    targets_found: 0,
    targets_saved: 0,
    targets: [] as z.infer<typeof OutreachTargetSchema>[],
    company_context: {
      company_name: companyName,
    },
    discovery_method: "web_search (failed — see fallback suggestions)",
    compliance_note:
      "All discovery methods are compliant. No scraping, no unauthorized access, no ToS violations.",
    none_found_fallback: buildNoneFoundFallback(
      companyName,
      jobTitle,
      targetFunction,
      hiringChain,
    ),
  };
}
