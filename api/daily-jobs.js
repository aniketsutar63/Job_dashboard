
module.exports = async (req, res) => {
  try {
    // 1. Environment variables
    const apiKey = process.env.CLEANJOBDATA_API_KEY;
    const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const dbKey = process.env.SUPABASE_SECRET_KEY;

    if (!apiKey || !rawUrl || !dbKey) {
      return res.status(500).json({
        success: false,
        error: "Required environment variables are missing",
        apiKeyFound: !!apiKey,
        supabaseUrlFound: !!rawUrl,
        supabaseKeyFound: !!dbKey
      });
    }

    const baseUrl = rawUrl.trim().replace(/\/+$/, "");
    const restUrl = baseUrl.endsWith("/rest/v1")
      ? baseUrl
      : `${baseUrl}/rest/v1`;

    const dbHeaders = {
      apikey: dbKey,
      Authorization: `Bearer ${dbKey}`
    };

    // 2. Search several keywords.
    // The provider may impose its own limit on results.
    const searchTerms = [
      "Java",
      "Spring Boot",
      "Java Backend",
      "Java Full Stack"
    ];

    async function searchJobs(keyword) {
      const params = new URLSearchParams({
        country_id: "101",
        title: keyword,
        experience_level: "EN,MI",
        created_max_age: "7d",
        limit: "50",
        sort_by: "published",
        include_expired: "false",
        extra_fields: "description"
      });

      const response = await fetch(
        `https://api.cleanjobdata.com/jobs?${params.toString()}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`
          }
        }
      );

      if (!response.ok) {
        return {
          keyword,
          success: false,
          status: response.status,
          jobs: []
        };
      }

      const result = await response.json();

      if (!result || !Array.isArray(result.data)) {
        return {
          keyword,
          success: false,
          status: 502,
          jobs: []
        };
      }

      return {
        keyword,
        success: true,
        jobs: result.data
      };
    }

    // Run all searches independently. A failed search does not
    // discard results from successful searches.
    const searchResults = await Promise.all(
      searchTerms.map(searchJobs)
    );

    const successfulSearches = searchResults.filter(
      result => result.success
    );

    const failedSearches = searchResults
      .filter(result => !result.success)
      .map(result => ({
        keyword: result.keyword,
        status: result.status
      }));

    if (successfulSearches.length === 0) {
      return res.status(502).json({
        success: false,
        error: "All CleanJobData searches failed. Existing jobs were preserved.",
        failedSearches
      });
    }

    const allJobs = successfulSearches.flatMap(
      result => result.jobs
    );

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

    // Compare both the normalized job identity and the URL.
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

        // Retain records when there is not enough information
        // to determine whether they are duplicates.
        if (!keys.length) return true;

        if (keys.some(key => seen.has(key))) {
          return false;
        }

        keys.forEach(key => seen.add(key));
        return true;
      });
    }

    // 4. Remove duplicate source IDs, then cross-search duplicates.
    const sourceIds = new Set();

    const uniqueById = allJobs.filter(job => {
      if (!job || typeof job !== "object") return false;
      if (job.id == null) return true;

      const id = String(job.id);

      if (sourceIds.has(id)) return false;

      sourceIds.add(id);
      return true;
    });

    const uniqueSourceJobs = deduplicate(uniqueById);

    // 5. Filter suitable job roles.
    // Do not restrict to a hard-coded city list: the source
    // search is already set to India, and remote listings may
    // have a location such as "Remote".
    const relevantJobs = uniqueSourceJobs.filter(job => {
      if (job.is_active === false) return false;

      const title = textValue(job.title).toLowerCase();
      const description = textValue(job.description).toLowerCase();
      const location = getLocation(job).toLowerCase();
      const combined = `${title} ${description}`;

      const relevantTitle =
        title.includes("java") ||
        title.includes("spring boot") ||
        title.includes("software developer") ||
        title.includes("software engineer") ||
        title.includes("backend developer") ||
        title.includes("backend engineer") ||
        title.includes("full stack") ||
        title.includes("application developer") ||
        title.includes("associate developer") ||
        title.includes("associate software engineer") ||
        title.includes("junior developer");

      if (!relevantTitle) return false;

      // Exclude explicitly senior/lead-only positions.
      const seniorTitle =
        /\bsenior\b|\bsr\.?\b|\blead\b|\bprincipal\b|\barchitect\b|\bdirector\b|\bmanager\b|\bhead of\b/i
          .test(title);

      if (seniorTitle) return false;

      // Exclude clearly stated minimum experience above 2 years.
      // Missing experience information is not automatically rejected.
      const experiencePatterns = [
        /minimum(?: of)?\s*(\d+)\s*\+?\s*years?/i,
        /at least\s*(\d+)\s*years?/i,
        /(\d+)\s*\+\s*years?\s+(?:of\s+)?experience/i,
        /(\d+)\s*-\s*(\d+)\s*years?\s+(?:of\s+)?experience/i,
        /experience\s*:\s*(\d+)\s*\+?\s*years?/i
      ];

      for (const pattern of experiencePatterns) {
        const match = combined.match(pattern);

        if (!match) continue;

        const minimum = Number(match[1]);

        if (minimum > 2) return false;
      }

      // The country filter is handled by CleanJobData.
      // Accept listings with a location or an explicit remote marker.
      const remote =
        /\bremote\b|\bwork from home\b|\bwfh\b|\bhybrid\b/i
          .test(`${title} ${location} ${description}`);

      return Boolean(location || remote);
    });

    const finalCandidates = deduplicate(relevantJobs);

    // 6. Format data for Supabase
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

      if (description) return description.substring(0, 500);

      return `${textValue(job.title) || "Java Developer"} opportunity at ${getCompany(job) || "the company"}.`;
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

    const incomingJobs = deduplicate(
      finalCandidates
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
        }))
    );

    // 7. Read existing records before making changes.
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
      const details = await existingResponse.text();

      return res.status(502).json({
        success: false,
        error: "Could not read existing jobs",
        details,
        existingJobsPreserved: true
      });
    }

    const existingJobs = await existingResponse.json();

    if (!Array.isArray(existingJobs)) {
      return res.status(502).json({
        success: false,
        error: "Invalid response from Supabase",
        existingJobsPreserved: true
      });
    }

    // 8. Retain existing recent records and remove duplicates
    // by deleting duplicate IDs individually.
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const retainedExisting = existingJobs.filter(job => {
      const dateValue = job["posted-at"] || job.created_at;
      const timestamp = dateValue ? Date.parse(dateValue) : NaN;

      // Preserve records with unknown dates rather than deleting them.
      if (!Number.isFinite(timestamp)) return true;

      return timestamp >= cutoff;
    });

    const seenExistingKeys = new Set();
    const keptExisting = [];
    const duplicateIds = [];

    for (const job of retainedExisting) {
      const keys = getKeys(job);

      if (
        keys.length &&
        keys.some(key => seenExistingKeys.has(key))
      ) {
        if (job.id != null) duplicateIds.push(String(job.id));
        continue;
      }

      keys.forEach(key => seenExistingKeys.add(key));
      keptExisting.push(job);
    }

    // 9. Remove duplicate saved rows individually.
    // Do not clear the complete jobs table.
    for (let i = 0; i < duplicateIds.length; i += 50) {
      const batch = duplicateIds.slice(i, i + 50);
      const deleteUrl = new URL(`${restUrl}/jobs`);

      deleteUrl.searchParams.set("id", `in.(${batch.join(",")})`);

      const deleteResponse = await fetch(deleteUrl.toString(), {
        method: "DELETE",
        headers: dbHeaders
      });

      if (!deleteResponse.ok) {
        const details = await deleteResponse.text();

        return res.status(502).json({
          success: false,
          error: "Could not remove duplicate saved records",
          details,
          existingJobsPreserved: true
        });
      }
    }

    // 10. Insert only jobs that do not match retained records.
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
      search_terms: searchTerms,
      successful_searches: successfulSearches.length,
      failed_searches: failedSearches,
      searched: allJobs.length,
      unique_source_jobs: uniqueSourceJobs.length,
      relevant: finalCandidates.length,
      incoming_unique: incomingJobs.length,
      existing_before_sync: existingJobs.length,
      existing_duplicates_removed: duplicateIds.length,
      new_jobs_found: jobsToInsert.length,
      inserted: insertedCount,
      cleared: false,
      retained_existing_jobs: true,
      search_window: "7 days",
      requested_limit_per_search: 50,
      message:
        "Multi-keyword job search completed. Existing records were retained, duplicates were checked, and new unique jobs were added."
    });

  } catch (error) {
    console.error("Daily jobs error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error"
    });
  }
};
