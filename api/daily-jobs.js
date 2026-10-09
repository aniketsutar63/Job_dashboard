
module.exports = async (req, res) => {
  try {
    // 1. Environment variables
    const cleanJobKey = process.env.CLEANJOBDATA_API_KEY;
    const rawSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;

    if (!cleanJobKey || !rawSupabaseUrl || !supabaseKey) {
      return res.status(500).json({
        success: false,
        error: "Required API environment variables are missing",
        cleanJobKeyFound: !!cleanJobKey,
        supabaseUrlFound: !!rawSupabaseUrl,
        supabaseKeyFound: !!supabaseKey
      });
    }

    const supabaseUrl = rawSupabaseUrl.trim().replace(/\/+$/, "");
    const supabaseRestUrl = supabaseUrl.endsWith("/rest/v1")
      ? supabaseUrl
      : `${supabaseUrl}/rest/v1`;

    const supabaseHeaders = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`
    };

    // 2. Fetch more recent Java jobs.
    // country_id=101 keeps the search focused on India.
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

    if (!sourceResponse.ok) {
      const details = await sourceResponse.text();

      return res.status(502).json({
        success: false,
        error: `CleanJobData API error: ${sourceResponse.status}`,
        details
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

    // 3. Normalization helpers
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
        job.company ||
        job.company_name ||
        job.employer
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

    // Matching title + company + location is important:
    // different URLs can refer to the same advertised job.
    function getKeys(job) {
      const title = normalize(job.title);
      const company = normalize(getCompany(job));
      const location = normalize(getLocation(job));
      const url = normalizeUrl(getApplyUrl(job));

      const keys = [];

      if (title && company && location) {
        keys.push(`job:${title}|${company}|${location}`);
      }

      if (url) {
        keys.push(`url:${url}`);
      }

      return keys;
    }

    function deduplicate(jobs) {
      const seen = new Set();

      return jobs.filter(job => {
        const keys = getKeys(job);

        if (keys.length === 0) return true;
        if (keys.some(key => seen.has(key))) return false;

        keys.forEach(key => seen.add(key));
        return true;
      });
    }

    // 4. Remove repeated source IDs first
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

    // 5. Filter suitable job titles and locations.
    // The API already requests India-based results.
    // Accept remote listings even when their location is simply
    // marked "Remote" or "Work from home".
    const relevantJobs = uniqueSourceJobs.filter(job => {
      if (job.is_active === false) return false;

      const title = textValue(job.title).toLowerCase();
      const location = getLocation(job).toLowerCase();
      const description = textValue(job.description).toLowerCase();

      const combined = `${title} ${description}`;

      const relevantTitle =
        title.includes("java") ||
        title.includes("software developer") ||
        title.includes("software engineer") ||
        title.includes("backend developer") ||
        title.includes("backend engineer") ||
        title.includes("full stack") ||
        title.includes("application developer") ||
        title.includes("associate developer");

      if (!relevantTitle) return false;

      const seniorTitle =
        /\bsenior\b|\bsr\.?\b|\blead\b|\bprincipal\b|\barchitect\b|\bdirector\b|\bmanager\b|\bhead of\b/i
          .test(title);

      if (seniorTitle) return false;

      // Filter clear minimum experience requirements above 2 years.
      // Do not reject a job when experience is not specified.
      const experiencePatterns = [
        /minimum(?: of)?\s*(\d+)\s*(?:\+?\s*)years?/i,
        /at least\s*(\d+)\s*years?/i,
        /(\d+)\s*\+\s*years?\s+(?:of\s+)?experience/i,
        /(\d+)\s*-\s*(\d+)\s*years?\s+(?:of\s+)?experience/i,
        /experience\s*:\s*(\d+)\s*\+?\s*years?/i
      ];

      for (const pattern of experiencePatterns) {
        const match = combined.match(pattern);

        if (match) {
          const minimum = Number(match[1]);

          if (minimum > 2) return false;
        }
      }

      // CleanJobData is queried with India's country ID.
      // Don't apply a hard-coded city allowlist, so Pune and other
      // Indian cities are not unnecessarily excluded.
      const remote =
        /\bremote\b|\bwork from home\b|\bwfh\b|\bhybrid\b/i
          .test(`${title} ${location} ${description}`);

      // Keep listings with a location, including remote listings.
      return !!location || remote;
    });

    const uniqueRelevantJobs = deduplicate(relevantJobs);

    // 6. Convert source jobs to the existing database schema
    function formatExperience(level) {
      const value = String(level || "").toUpperCase();

      if (value === "EN") return "Entry Level";
      if (value === "MI") return "Mid Level";
      if (value === "SE") return "Senior";
      if (value === "EX") return "Executive";

      return level || "Not specified";
    }

    function calculateFitScore(job) {
      const content = `
        ${job.title || ""}
        ${job.description || ""}
        ${job.experience_level || ""}
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
      const content = `
        ${job.title || ""}
        ${job.description || ""}
      `.toLowerCase();

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
      const content = `
        ${job.title || ""}
        ${job.description || ""}
      `.toLowerCase();

      const missing = [];

      if (!content.includes("docker")) missing.push("Docker");
      if (!content.includes("kubernetes")) missing.push("Kubernetes");
      if (!content.includes("aws")) missing.push("AWS");
      if (!content.includes("microservices")) {
        missing.push("Microservices");
      }

      return missing.join(", ");
    }

    const incomingJobs = uniqueRelevantJobs
      .filter(job => !!getApplyUrl(job))
      .map(job => ({
        title: textValue(job.title) || "Java Developer",
        company: getCompany(job) || "Unknown",
        location: getLocation(job) || "India / Remote",
        experience: formatExperience(job.experience_level),
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
      }));

    // 7. Read existing jobs BEFORE changing the database.
    // If this fails, stop safely and retain the current records.
    const existingResponse = await fetch(
      `${supabaseRestUrl}/jobs?select=*`,
      {
        method: "GET",
        headers: {
          ...supabaseHeaders,
          Accept: "application/json"
        }
      }
    );

    if (!existingResponse.ok) {
      const details = await existingResponse.text();

      return res.status(502).json({
        success: false,
        error: "Could not read existing Supabase jobs",
        details,
        existingJobsPreserved: true
      });
    }

    const existingJobs = await existingResponse.json();

    if (!Array.isArray(existingJobs)) {
      return res.status(502).json({
        success: false,
        error: "Supabase returned an invalid jobs response",
        existingJobsPreserved: true
      });
    }

    // 8. Keep existing recent jobs and identify existing duplicates.
    const now = Date.now();
    const retentionDays = 7;
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    const recentExistingJobs = existingJobs.filter(job => {
      const dateValue = job["posted-at"] || job.created_at;
      const timestamp = dateValue ? Date.parse(dateValue) : NaN;

      // Keep undated records rather than deleting potentially useful jobs.
      if (!Number.isFinite(timestamp)) return true;

      return now - timestamp <= retentionMs;
    });

    // Prefer existing records as the initial set, then add only new jobs.
    const keptJobs = deduplicate(recentExistingJobs);
    const knownKeys = new Set();

    keptJobs.forEach(job => {
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

    // 9. Remove duplicate old records by their IDs only.
    // Do not clear the whole table.
    const keepIds = new Set(
      keptJobs
        .map(job => job.id)
        .filter(id => id != null)
        .map(String)
    );

    const duplicateIds = [];

    for (const job of recentExistingJobs) {
      if (job.id == null) continue;

      const id = String(job.id);
      if (!keepIds.has(id)) continue;

      // A kept ID is the first record for its identity.
      // Duplicate detection below chooses one record per identity.
    }

    // Determine which existing IDs are duplicates, preserving the
    // first occurrence of each job identity.
    const existingKeysSeen = new Set();
    const idsToDelete = [];

    for (const job of recentExistingJobs) {
      const keys = getKeys(job);

      if (!keys.length) continue;

      if (keys.some(key => existingKeysSeen.has(key))) {
        if (job.id != null) idsToDelete.push(String(job.id));
        continue;
      }

      keys.forEach(key => existingKeysSeen.add(key));
    }

    // Remove duplicate existing records individually.
    // Batch small groups to keep URL length manageable.
    for (let i = 0; i < idsToDelete.length; i += 50) {
      const batch = idsToDelete.slice(i, i + 50);

      const deleteUrl = new URL(`${supabaseRestUrl}/jobs`);
      deleteUrl.searchParams.set("id", `in.(${batch.join(",")})`);

      const deleteResponse = await fetch(deleteUrl.toString(), {
        method: "DELETE",
        headers: supabaseHeaders
      });

      if (!deleteResponse.ok) {
        const details = await deleteResponse.text();

        return res.status(502).json({
          success: false,
          error: "Could not remove duplicate existing records",
          details,
          newJobsInserted: 0
        });
      }
    }

    // 10. Insert only new jobs, retaining existing records.
    let insertedCount = 0;

    if (jobsToInsert.length > 0) {
      const insertResponse = await fetch(
        `${supabaseRestUrl}/jobs`,
        {
          method: "POST",
          headers: {
            ...supabaseHeaders,
            "Content-Type": "application/json",
            Prefer: "return=representation"
          },
          body: JSON.stringify(jobsToInsert)
        }
      );

      if (!insertResponse.ok) {
        const details = await insertResponse.text();

        return res.status(502).json({
          success: false,
          error: "Could not insert new jobs",
          details,
          existingJobsPreserved: true,
          attemptedInsertCount: jobsToInsert.length
        });
      }

      const insertedRows = await insertResponse.json();

      insertedCount = Array.isArray(insertedRows)
        ? insertedRows.length
        : jobsToInsert.length;
    }

    return res.status(200).json({
      success: true,
      searched: sourceJobs.length,
      unique: uniqueSourceJobs.length,
      relevant: uniqueRelevantJobs.length,
      incoming_unique: incomingJobs.length,
      existing_before_sync: existingJobs.length,
      existing_duplicates_removed: idsToDelete.length,
      new_jobs_found: jobsToInsert.length,
      inserted: insertedCount,
      cleared: false,
      retained_existing_jobs: true,
      search_window: "7 days",
      requested_limit: 50,
      message:
        "Job sync completed. Existing jobs were retained, duplicates were cleaned up, and new unique jobs were added."
    });

  } catch (error) {
    console.error("Daily jobs error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error"
    });
  }
};
