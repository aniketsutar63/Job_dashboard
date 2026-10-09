
module.exports = async (req, res) => {
  try {
    // 1. Environment variables
    const cleanJobKey = process.env.CLEANJOBDATA_API_KEY;
    const rawSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;

    if (!cleanJobKey || !rawSupabaseUrl || !supabaseKey) {
      return res.status(500).json({
        success: false,
        error: "Required environment variables are missing"
      });
    }

    const baseUrl = rawSupabaseUrl.trim().replace(/\/+$/, "");
    const restUrl = baseUrl.endsWith("/rest/v1")
      ? baseUrl
      : `${baseUrl}/rest/v1`;

    const dbHeaders = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`
    };

    // 2. One source request per sync to reduce rate limiting
    const params = new URLSearchParams({
      country_id: "101",
      title: "Java",
      experience_level: "EN,MI",
      created_max_age: "7d",
      limit: "50",
      sort_by: "published",
      include_expired: "false",
      extra_fields: "description"
    });

    const sourceResponse = await fetch(
      `https://api.cleanjobdata.com/jobs?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cleanJobKey}`
        }
      }
    );

    if (sourceResponse.status === 429) {
      return res.status(429).json({
        success: false,
        error: "CleanJobData rate limit reached",
        retry_after: sourceResponse.headers.get("retry-after"),
        message: "Existing jobs were not changed. Wait before syncing again."
      });
    }

    if (!sourceResponse.ok) {
      return res.status(502).json({
        success: false,
        error: `CleanJobData API error: ${sourceResponse.status}`,
        details: await sourceResponse.text()
      });
    }

    const sourceResult = await sourceResponse.json();

    if (!sourceResult || !Array.isArray(sourceResult.data)) {
      return res.status(502).json({
        success: false,
        error: "CleanJobData returned an invalid response"
      });
    }

    const sourceJobs = sourceResult.data;

    // 3. Helpers
    function textValue(value) {
      if (value == null) return "";

      if (Array.isArray(value)) {
        return value.map(textValue).filter(Boolean).join(" ");
      }

      if (typeof value === "object") {
        return textValue(
          value.name ||
          value.display_name ||
          value.city ||
          value.label ||
          value.value ||
          ""
        );
      }

      return String(value);
    }

    function normalize(value) {
      return textValue(value)
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    }

    function normalizeUrl(value) {
      if (!value) return "";

      try {
        const parsed = new URL(String(value).trim());

        return (
          parsed.hostname.toLowerCase().replace(/^www\./, "") +
          parsed.pathname.replace(/\/+$/, "")
        ).toLowerCase();
      } catch {
        return normalize(value);
      }
    }

    function getCompany(job) {
      return textValue(
        job.company || job.company_name || job.employer
      );
    }

    function getLocation(job) {
      return textValue(
        job.location ||
        job.job_location ||
        job.candidate_required_location
      );
    }

    function getApplyUrl(job) {
      return (
        job.application_url ||
        job.apply_url ||
        job["apply-url"] ||
        ""
      );
    }

    function getKeys(job) {
      const title = normalize(job.title);
      const company = normalize(getCompany(job));
      const location = normalize(getLocation(job));
      const url = normalizeUrl(getApplyUrl(job));
      const keys = [];

      if (title && company && location) {
        keys.push(`job:${title}|${company}|${location}`);
      }

      if (url) keys.push(`url:${url}`);

      return keys;
    }

    function deduplicate(jobs) {
      const seen = new Set();

      return jobs.filter(job => {
        const keys = getKeys(job);

        if (!keys.length) return true;
        if (keys.some(key => seen.has(key))) return false;

        keys.forEach(key => seen.add(key));
        return true;
      });
    }

    // 4. Remove duplicate source IDs and duplicate jobs
    const sourceIds = new Set();

    const uniqueById = sourceJobs.filter(job => {
      if (!job || typeof job !== "object") return false;
      if (job.id == null) return true;

      const id = String(job.id);

      if (sourceIds.has(id)) return false;

      sourceIds.add(id);
      return true;
    });

    const uniqueSourceJobs = deduplicate(uniqueById);

    // 5. Detect explicit minimum experience requirements.
    // Returns null when no clear minimum is found.
    function getRequiredYears(job) {
      const description = textValue(job.description)
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ");

      const title = textValue(job.title);
      const text = `${title}. ${description}`;

      const patterns = [
        /\bminimum\s+(?:of\s+)?(\d+)\s*\+?\s*years?\b/i,
        /\bmin\.?\s+experience\s*:\s*(\d+)\s*\+?\s*years?\b/i,
        /\bminimum\s+experience\s*:\s*(\d+)\s*\+?\s*years?\b/i,
        /\bat\s+least\s+(\d+)\s*years?\b/i,
        /\b(\d+)\s*\+\s*years?\s+(?:of\s+)?experience\b/i,
        /\bexperience\s*:\s*(\d+)\s*\+?\s*years?\b/i,
        /\brequires?\s+(\d+)\s*\+?\s*years?\s+(?:of\s+)?experience\b/i,
        /\b(\d+)\s*-\s*\d+\s+years?\s+(?:of\s+)?experience\b/i,
        /\b(\d+)\s+years?\s+(?:of\s+)?(?:relevant\s+)?experience\s+(?:required|minimum)\b/i
      ];

      for (const pattern of patterns) {
        const match = text.match(pattern);

        if (match) return Number(match[1]);
      }

      return null;
    }

    // 6. Filter relevant jobs and record rejection reasons
    const rejected = {
      inactive: 0,
      irrelevant_title: 0,
      senior_title: 0,
      experience_over_2_years: 0,
      missing_location: 0
    };

    const rejectedExamples = [];

    const relevantJobs = uniqueSourceJobs.filter(job => {
      let reason = "";

      const title = textValue(job.title).toLowerCase();
      const description = textValue(job.description).toLowerCase();
      const location = getLocation(job).toLowerCase();
      const combined = `${title} ${description}`;

      if (job.is_active === false) {
        reason = "inactive";
      } else {
        const relevantTitle =
          /\bjava\b/.test(title) ||
          /\bspring\s*boot\b/.test(title) ||
          /\bsoftware developer\b/.test(title) ||
          /\bsoftware engineer\b/.test(title) ||
          /\bbackend developer\b/.test(title) ||
          /\bbackend engineer\b/.test(title) ||
          /\bback end developer\b/.test(title) ||
          /\bfull stack\b/.test(title) ||
          /\bapplication developer\b/.test(title) ||
          /\bassociate developer\b/.test(title) ||
          /\bjunior developer\b/.test(title);

        if (!relevantTitle) {
          reason = "irrelevant_title";
        } else if (
          /\bsenior\b|\bsr\.?\b|\blead\b|\bprincipal\b|\barchitect\b|\bdirector\b|\bmanager\b|\bhead of\b/i
            .test(title)
        ) {
          reason = "senior_title";
        } else {
          const years = getRequiredYears(job);

          if (years !== null && years > 2) {
            reason = "experience_over_2_years";
          } else if (!location) {
            reason = "missing_location";
          }
        }
      }

      if (reason) {
        rejected[reason]++;

        // Return only a few examples to help diagnose filtering.
        if (rejectedExamples.length < 15) {
          rejectedExamples.push({
            title: textValue(job.title),
            company: getCompany(job),
            experience_level: textValue(job.experience_level),
            detected_minimum_years: getRequiredYears(job),
            reason
          });
        }

        return false;
      }

      return true;
    });

    const finalCandidates = deduplicate(relevantJobs);

    // 7. Format experience and job details
    function formatExperience(job) {
      const years = getRequiredYears(job);

      if (years !== null) {
        return years === 0
          ? "Entry Level"
          : `${years}+ years required`;
      }

      const value = textValue(job.experience_level).toUpperCase();

      if (value === "EN") return "Entry Level";
      if (value === "MI") return "Mid Level";
      if (value === "SE") return "Senior";
      if (value === "EX") return "Executive";

      return textValue(job.experience_level) || "Experience Not Specified";
    }

    function calculateFitScore(job) {
      const content = `
        ${job.title || ""}
        ${job.description || ""}
      `.toLowerCase();

      let score = 60;

      if (content.includes("java")) score += 10;
      if (content.includes("spring boot")) score += 10;
      if (content.includes("spring")) score += 5;
      if (content.includes("rest")) score += 5;
      if (content.includes("hibernate")) score += 3;
      if (content.includes("mysql")) score += 2;
      if (content.includes("react")) score += 2;
      if (content.includes("git")) score += 1;
      if (content.includes("maven")) score += 1;

      return Math.min(score, 100);
    }

    function createSummary(job) {
      const description = textValue(job.description)
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

      return description
        ? description.substring(0, 500)
        : `${textValue(job.title) || "Java Developer"} opportunity at ${getCompany(job) || "the company"}.`;
    }

    function createWhyMatch(job) {
      const content = `${job.title || ""} ${job.description || ""}`.toLowerCase();
      const skills = [];

      if (content.includes("java")) skills.push("Java");
      if (content.includes("spring boot")) skills.push("Spring Boot");
      if (content.includes("rest")) skills.push("REST APIs");
      if (content.includes("sql") || content.includes("mysql")) {
        skills.push("SQL/MySQL");
      }
      if (content.includes("react")) skills.push("React");
      if (content.includes("hibernate") || content.includes("jpa")) {
        skills.push("Hibernate/JPA");
      }

      return skills.length
        ? `Matches profile skills: ${skills.join(", ")}.`
        : "Potential match for the Java development profile.";
    }

    function createMissingSkills(job) {
      const content = `${job.title || ""} ${job.description || ""}`.toLowerCase();
      const missing = [];

      if (!content.includes("docker")) missing.push("Docker");
      if (!content.includes("kubernetes")) missing.push("Kubernetes");
      if (!content.includes("aws")) missing.push("AWS");
      if (!content.includes("microservices")) missing.push("Microservices");

      return missing.join(", ");
    }

    const incomingJobs = deduplicate(
      finalCandidates
        .filter(job => !!getApplyUrl(job))
        .map(job => ({
          title: textValue(job.title) || "Java Developer",
          company: getCompany(job) || "Unknown",
          location: getLocation(job) || "India / Remote",
          experience: formatExperience(job),
          "posted-at":
            job.published ||
            job.posted_at ||
            job["posted-at"] ||
            new Date().toISOString(),
          category: "Java / Backend",
          fit_score: calculateFitScore(job),
          summary: createSummary(job),
          "why-match": createWhyMatch(job),
          "missing-skills": createMissingSkills(job),
          "apply-url": getApplyUrl(job),
          source: "CleanJobData"
        }))
    );

    // 8. Read existing Supabase jobs
    const existingResponse = await fetch(
      `${restUrl}/jobs?select=*`,
      {
        method: "GET",
        headers: {
          ...dbHeaders,
          Accept: "application/json"
        }
      }
    );

    if (!existingResponse.ok) {
      return res.status(502).json({
        success: false,
        error: "Could not read existing Supabase jobs",
        details: await existingResponse.text(),
        existingJobsPreserved: true
      });
    }

    const existingJobs = await existingResponse.json();

    if (!Array.isArray(existingJobs)) {
      return res.status(502).json({
        success: false,
        error: "Invalid Supabase jobs response",
        existingJobsPreserved: true
      });
    }

    // 9. Identify duplicate saved rows without clearing the table
    const seenExistingKeys = new Set();
    const keptExisting = [];
    const duplicateIds = [];

    for (const job of existingJobs) {
      const keys = getKeys(job);

      if (keys.length && keys.some(key => seenExistingKeys.has(key))) {
        if (job.id != null) duplicateIds.push(String(job.id));
        continue;
      }

      keys.forEach(key => seenExistingKeys.add(key));
      keptExisting.push(job);
    }

    // Delete only identified duplicate IDs
    for (let i = 0; i < duplicateIds.length; i += 50) {
      const batch = duplicateIds.slice(i, i + 50);
      const deleteUrl = new URL(`${restUrl}/jobs`);

      deleteUrl.searchParams.set("id", `in.(${batch.join(",")})`);

      const deleteResponse = await fetch(deleteUrl.toString(), {
        method: "DELETE",
        headers: dbHeaders
      });

      if (!deleteResponse.ok) {
        return res.status(502).json({
          success: false,
          error: "Could not remove duplicate saved jobs",
          details: await deleteResponse.text()
        });
      }
    }

    // 10. Insert only new unique jobs
    const knownKeys = new Set();

    keptExisting.forEach(job => {
      getKeys(job).forEach(key => knownKeys.add(key));
    });

    const jobsToInsert = [];

    for (const job of incomingJobs) {
      const keys = getKeys(job);

      if (keys.length && keys.some(key => knownKeys.has(key))) {
        continue;
      }

      jobsToInsert.push(job);
      keys.forEach(key => knownKeys.add(key));
    }

    let insertedCount = 0;

    if (jobsToInsert.length > 0) {
      const insertResponse = await fetch(`${restUrl}/jobs`, {
        method: "POST",
        headers: {
          ...dbHeaders,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(jobsToInsert)
      });

      if (!insertResponse.ok) {
        return res.status(502).json({
          success: false,
          error: "Supabase insert failed",
          details: await insertResponse.text(),
          existingJobsPreserved: true
        });
      }

      const insertedRows = await insertResponse.json();

      insertedCount = Array.isArray(insertedRows)
        ? insertedRows.length
        : jobsToInsert.length;
    }

    // 11. Diagnostics
    return res.status(200).json({
      success: true,
      search_terms: ["Java"],
      successful_searches: 1,
      searched: sourceJobs.length,
      unique_source_jobs: uniqueSourceJobs.length,
      relevant: finalCandidates.length,
      incoming_unique: incomingJobs.length,
      existing_before_sync: existingJobs.length,
      existing_duplicates_removed: duplicateIds.length,
      new_jobs_found: jobsToInsert.length,
      inserted: insertedCount,
      rejected_counts: rejected,
      rejected_examples: rejectedExamples,
      cleared: false,
      retained_existing_jobs: true,
      search_window: "7 days",
      requested_limit: 50,
      message:
        "Sync completed. Existing jobs were retained and new unique jobs were added."
    });

  } catch (error) {
    console.error("Daily jobs error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error"
    });
  }
};
