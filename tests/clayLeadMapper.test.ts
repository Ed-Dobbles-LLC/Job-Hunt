import { describe, it, expect } from "vitest";
import { mapClayLead } from "../src/mastra/tools/clayLeadMapper";

describe("clayLeadMapper", () => {
  it("maps the original snake_case shape (backwards compatible)", () => {
    const lead = mapClayLead({
      company_name: "Sprouts Farmers Market",
      job_title: "VP Analytics",
      location: "Phoenix, AZ",
      job_url: "https://example.com/job/1",
      job_description: "Lead the analytics org.",
      compensation: "$250k",
      clay_row_id: "row-123",
      contact_name: "Jane Recruiter",
      contact_email: "jane@example.com",
    });
    expect(lead.company).toBe("Sprouts Farmers Market");
    expect(lead.title).toBe("VP Analytics");
    expect(lead.location).toBe("Phoenix, AZ");
    expect(lead.postingUrl).toBe("https://example.com/job/1");
    expect(lead.jdText).toBe("Lead the analytics org.");
    expect(lead.compensation).toBe("$250k");
    expect(lead.clayRowId).toBe("row-123");
    expect(lead.contactName).toBe("Jane Recruiter");
    expect(lead.contactEmail).toBe("jane@example.com");
  });

  it("maps Clay display-style headers with spaces and capitals (the production failure)", () => {
    const lead = mapClayLead({
      "Company Name": "Molson Coors",
      "Job Title": "VP Advanced Analytics",
      "Location": "Chicago, IL",
      "Job URL": "https://example.com/job/2",
      "Job Description": "Own forecasting and pricing analytics.",
      "Salary Range": "$240k-$280k",
      "Hiring Contact": "Sam Recruiter",
    });
    expect(lead.company).toBe("Molson Coors");
    expect(lead.title).toBe("VP Advanced Analytics");
    expect(lead.location).toBe("Chicago, IL");
    expect(lead.postingUrl).toBe("https://example.com/job/2");
    expect(lead.jdText).toBe("Own forecasting and pricing analytics.");
    expect(lead.compensation).toBe("$240k-$280k");
    expect(lead.contactName).toBe("Sam Recruiter");
  });

  it("unwraps a nested `fields` wrapper", () => {
    const lead = mapClayLead({
      id: "evt-9",
      fields: {
        Company: "WECU",
        Role: "VP Business Intelligence",
        City: "Bellingham, WA",
        Link: "https://example.com/job/3",
      },
    });
    expect(lead.company).toBe("WECU");
    expect(lead.title).toBe("VP Business Intelligence");
    expect(lead.location).toBe("Bellingham, WA");
    expect(lead.postingUrl).toBe("https://example.com/job/3");
  });

  it("still rejects a genuinely empty lead, and surfaces received keys for diagnostics", () => {
    const lead = mapClayLead({ irrelevant_field: "x", another_thing: 42 });
    expect(lead.company).toBe("");
    expect(lead.title).toBe("");
    expect(lead.rawKeys).toEqual(["irrelevant_field", "another_thing"]);
  });

  it("treats whitespace-only and 'null' strings as empty", () => {
    const lead = mapClayLead({ "Company Name": "   ", "Job Title": "null" });
    expect(lead.company).toBe("");
    expect(lead.title).toBe("");
  });

  it("handles non-object inputs without throwing", () => {
    expect(mapClayLead(null).company).toBe("");
    expect(mapClayLead("string").company).toBe("");
    expect(mapClayLead(42).title).toBe("");
  });
});
