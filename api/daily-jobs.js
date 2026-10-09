
module.exports = async (req, res) => {
  try {
    // 1. Environment variables
    const cleanJobKey = process.env.CLEANJOBDATA_API_KEY;
    const rawSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;

    if (!cleanJobKey) {
      return res.status(500).json({
        success: false,
        error: "CLEANJOBDATA_API_KEY is missing"
      });
    }

    if (!rawSupabaseUrl || !supabaseKey) {
      return res.status(500).json({
        success: false,
        error: "Supabase environment variables are missing",
        supabaseUrlFound: !!rawSupabaseUrl,
        supabaseKeyFound: !!supabaseKey
      });
    }

    // 2. Supabase REST URL
    const supabaseUrl = rawSupabaseUrl.trim().replace(/\/+$/, "");
    const supabaseRestUrl = supabaseUrl.endsWith("/rest/v1")
      ? supabaseUrl
      : `${supabaseUrl}/rest/v1`;

    const supabaseHeaders = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`
    };

    // 3. Fetch the latest Java jobs
    const params = new URLSearchParams({
      country_id: "101",
      title: "Java",
      experience_level: "EN,MI",
      created_max_age: "24h",
      limit: "20",
      sort_by: "published",
      include_expired: "false",
      extra_fields: "description"
    });

    const response = await fetch(
      `https://api.cleanjobdata.com/jobs?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cleanJobKey}`
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      return res.status(502).json({
        success: false,
        error: `CleanJob API error: ${response.status}`,
        details: errorText
      });
    }

    const result = await response.json();

    if (!result || !Array.isArray(result.data)) {
      return res.status(502).json({
        success: false,
        error: "CleanJobData returned an invalid response"
      });
    }

    const allJobs = result.data;

    // 4. Normalization helpers
    function getText(value) {
      if (value == null) return "";

      if (Array.isArray(value)) {
        return value.map(getText).filter(Boolean).join(" ");
      }

      if (typeof value === "object") {
        return getText(
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

    function normalizeText(value) {
      return getText(value)
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
        return normalizeText(value);
      }
    }

    // Use BOTH job identity and application URL.
    // Matching either key identifies a duplicate.
    function getJobKeys(job) {
      const title = normalizeText(job.title);
      const company = normalizeText(job.company);
      const location = normalizeText(job.location);

      const keys = [];

      if (title && company && location) {
        keys.push(`job:${title}|${company}|${location}`);
      }

      const applyUrl =
        job.application_url ||
        job["apply-url"] ||
        job.apply_url;

      const normalizedUrl = normalizeUrl(applyUrl);

      if (normalizedUrl) {
        keys.push(`url:${normalizedUrl}`);
      }

      return keys;
    }

    // 5. Remove duplicates from CleanJobData
    const sourceIds = new Set();

    const uniqueById = allJobs.filter(job => {
      if (!job || typeof job !== "object") return false;

      if (job.id == null) return true;

      const id = String(job.id);

      if (sourceIds.has(id)) return false;

      sourceIds.add(id);
      return true;
    });

    function deduplicateJobs(jobs) {
      const seenKeys = new Set();

      return jobs.filter(job => {
        const keys = getJobKeys(job);

        if (keys.length === 0) {
          // Keep jobs without enough information to compare.
          return true;
        }

        if (keys.some(key => seenKeys.has(key))) {
          return false;
        }

        keys.forEach(key => seenKeys.add(key));
        return true;
      });
    }

    const uniqueJobs = deduplicateJobs(uniqueById);

    // 6. Filter relevant India-based Java jobs
    const indiaLocations = [
      "india",
      "pune",
      "bangalore",
      "bengaluru",
      "hyderabad",
      "mumbai",
      "delhi",
      "noida",
      "gurgaon",
      "gurugram",
      "chennai",
      "kolkata",
      "ahmedabad",
      "indore",
      "coimbatore",
      "thiruvananthapuram",
      "kerala"
    ];

    const filteredJobs = uniqueJobs.filter(job => {
      if (job.is_active === false) return false;

      const title = getText(job.title).toLowerCase();
      const location = getText(job.location).toLowerCase();
      const description = getText(job.description).toLowerCase();

      const hasJava =
        title.includes("java") ||
        description.includes("java");

      if (!hasJava) return false;

      const hasIndiaLocation = indiaLocations.some(place =>
        location.includes(place)
      );

      if (!hasIndiaLocation) return false;

      const relevantRole =
        title.includes("java") ||
        title.includes("software engineer") ||
        title.includes("software developer") ||
        title.includes("backend developer") ||
        title.includes("backend engineer") ||
        title.includes("full stack") ||
        title.includes("spring boot") ||
        title.includes("application developer") ||
        title.includes("associate software engineer") ||
        title.includes("associate developer") ||
        title.includes("junior developer");

      if (!relevantRole) return false;

      const seniorRole =
        title.includes("senior") ||
        title.includes("sr.") ||
        title.includes("lead") ||
        title.includes("principal") ||
        title.includes("architect") ||
        title.includes("director") ||
        title.includes("manager") ||
        title.includes("head of");

      return !seniorRole;
    });

    // 7. Deduplicate once more after filtering
    const deduplicatedFilteredJobs = deduplicateJobs(filteredJobs);

    // 8. Prepare records for Supabase
    const newJobs = deduplicatedFilteredJobs
      .filter(job => {
        const url =
          job.application_url ||
          job["apply-url"] ||
          job.apply_url;

        return !!url;
      })
      .map(job => {
        const company =
          getText(job.company) || "Unknown";

        const applicationUrl =
          job.application_url ||
          job["apply-url"] ||
          job.apply_url;

        return {
          title: getText(job.title) || "Java Developer",
          company,
          location: getText(job.location) || "India",
          experience: formatExperience(job.experience_level),
          "posted-at":
            job.published ||
            job["posted-at"] ||
            new Date().toISOString(),
          category: "Java / Backend",
          fit_score: calculateFitScore(job),
          summary: createSummary(job),
          "why-match": createWhyMatch(job),
          "missing-skills": createMissingSkills(job),
          "apply-url": applicationUrl,
          source: "CleanJobData"
        };
      });

    // Final safeguard: deduplicate the actual database payload
    const finalPayload = deduplicateJobs(newJobs);

    // Do not erase existing records if no usable jobs were found.
    if (finalPayload.length === 0) {
      return res.status(200).json({
        success: true,
        searched: allJobs.length,
        unique: uniqueJobs.length,
        relevant: filteredJobs.length,
        deduplicated: deduplicatedFilteredJobs.length,
        duplicates_removed:
          filteredJobs.length - deduplicatedFilteredJobs.length,
        cleared: false,
        inserted: 0,
        message:
          "No usable jobs were found. Existing Supabase jobs were preserved."
      });
    }

    // 9. Clear previous jobs
    const deleteResponse = await fetch(
      `${supabaseRestUrl}/jobs?id=not.is.null`,
      {
        method: "DELETE",
        headers: {
          ...supabaseHeaders,
          Accept: "application/json"
        }
      }
    );

    if (!deleteResponse.ok) {
      const errorText = await deleteResponse.text();

      return res.status(502).json({
        success: false,
        error: "Could not clear previous jobs",
        details: errorText
      });
    }

    // 10. Insert latest unique jobs
    const insertResponse = await fetch(
      `${supabaseRestUrl}/jobs`,
      {
        method: "POST",
        headers: {
          ...supabaseHeaders,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(finalPayload)
      }
    );

    if (!insertResponse.ok) {
      const errorText = await insertResponse.text();

      return res.status(502).json({
        success: false,
        error: "Supabase insert failed after clearing old jobs",
        details: errorText,
        warning:
          "Previous jobs were cleared; check Supabase before retrying."
      });
    }

    const insertedRows = await insertResponse.json();

    // 11. Return sync details
    return res.status(200).json({
      success: true,
      searched: allJobs.length,
      unique: uniqueJobs.length,
      relevant: filteredJobs.length,
      deduplicated: deduplicatedFilteredJobs.length,
      duplicates_removed:
        filteredJobs.length - deduplicatedFilteredJobs.length,
      prepared_for_insert: finalPayload.length,
      cleared: true,
      inserted: Array.isArray(insertedRows)
        ? insertedRows.length
        : finalPayload.length,
      message:
        "Latest unique Java jobs saved successfully"
    });

  } catch (error) {
    console.error("Daily jobs error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error"
    });
  }
};

// Format experience level
function formatExperience(level) {
  if (!level) return "0–3 years";

  const value = String(level).toUpperCase();

  if (value === "EN") return "Entry Level";
  if (value === "MI") return "Mid Level";
  if (value === "SE") return "Senior";
  if (value === "EX") return "Executive";

  return level;
}

// Calculate profile match score
function calculateFitScore(job) {
  const text = `
    ${job.title || ""}
    ${job.description || ""}
    ${job.experience_level || ""}
  `.toLowerCase();

  let score = 60;

  if (text.includes("java")) score += 10;
  if (text.includes("spring boot")) score += 10;
  if (text.includes("spring")) score += 5;
  if (text.includes("rest")) score += 5;
  if (text.includes("hibernate")) score += 3;
  if (text.includes("mysql")) score += 2;
  if (text.includes("react")) score += 2;
  if (text.includes("git")) score += 1;
  if (text.includes("maven")) score += 1;

  return Math.min(score, 100);
}

// Create job summary
function createSummary(job) {
  const description = String(job.description || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!description) {
    const company =
      typeof job.company === "string"
        ? job.company
        : job.company?.name ||
          job.company?.display_name ||
          "the company";

    return `${job.title || "Java Developer"} opportunity at ${company}.`;
  }

  return description.substring(0, 500);
}

// Explain why the job matches
function createWhyMatch(job) {
  const text = `
    ${job.title || ""}
    ${job.description || ""}
  `.toLowerCase();

  const matches = [];

  if (text.includes("java")) matches.push("Java");
  if (text.includes("spring boot")) matches.push("Spring Boot");
  if (text.includes("rest")) matches.push("REST APIs");

  if (text.includes("sql") || text.includes("mysql")) {
    matches.push("SQL/MySQL");
  }

  if (text.includes("react")) matches.push("React");

  if (text.includes("hibernate") || text.includes("jpa")) {
    matches.push("Hibernate/JPA");
  }

  if (matches.length === 0) {
    return "Matches the Java development profile.";
  }

  return `Matches profile skills: ${matches.join(", ")}.`;
}

// List skills not mentioned in the job description
function createMissingSkills(job) {
  const text = `
    ${job.title || ""}
    ${job.description || ""}
  `.toLowerCase();

  const missing = [];

  if (!text.includes("docker")) missing.push("Docker");
  if (!text.includes("kubernetes")) missing.push("Kubernetes");
  if (!text.includes("aws")) missing.push("AWS");
  if (!text.includes("microservices")) missing.push("Microservices");

  return missing.join(", ");
}
