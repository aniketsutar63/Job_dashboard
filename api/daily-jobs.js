
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

    // 3. Fetch latest Java jobs
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

      return res.status(response.status === 429 ? 429 : 502).json({
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

    // 4. Normalize values for duplicate detection
    function normalizeText(value) {
      return String(value || "")
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
        parsed.hash = "";
        parsed.search = "";

        return (
          parsed.hostname.toLowerCase().replace(/^www\./, "") +
          parsed.pathname.replace(/\/+$/, "")
        ).toLowerCase();
      } catch {
        return normalizeText(value);
      }
    }

    function getJobKeys(job) {
      const title = normalizeText(job.title);
      const company = normalizeText(
        job.company?.name || job.company?.display_name
      );
      const location = normalizeText(job.location);
      const url = normalizeUrl(job.application_url);

      const keys = [];

      if (url) {
        keys.push(`url:${url}`);
      }

      if (title && company && location) {
        keys.push(`job:${title}|${company}|${location}`);
      }

      return keys;
    }

    // 5. Deduplicate the source results
    const sourceIds = new Set();

    const uniqueById = allJobs.filter(job => {
      if (!job || job.id == null) return false;

      const id = String(job.id);

      if (sourceIds.has(id)) return false;

      sourceIds.add(id);
      return true;
    });

    const seenKeys = new Set();

    const uniqueJobs = uniqueById.filter(job => {
      const keys = getJobKeys(job);

      if (keys.length && keys.some(key => seenKeys.has(key))) {
        return false;
      }

      keys.forEach(key => seenKeys.add(key));
      return true;
    });

    // 6. Filter relevant India-based Java jobs
    const filteredJobs = uniqueJobs.filter(job => {
      if (job.is_active === false) return false;

      const title = String(job.title || "").toLowerCase();
      const location = String(job.location || "").toLowerCase();
      const description = String(job.description || "").toLowerCase();

      const hasJava =
        title.includes("java") || description.includes("java");

      if (!hasJava) return false;

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
        "coimbatore"
      ];

      if (!indiaLocations.some(place => location.includes(place))) {
        return false;
      }

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

    // 7. Deduplicate again after filtering
    const preparedKeys = new Set();

    const deduplicatedFilteredJobs = filteredJobs.filter(job => {
      const keys = getJobKeys(job);

      if (keys.length && keys.some(key => preparedKeys.has(key))) {
        return false;
      }

      keys.forEach(key => preparedKeys.add(key));
      return true;
    });

    // 8. Prepare jobs for Supabase
    const newJobs = deduplicatedFilteredJobs
      .filter(job => !!job.application_url)
      .map(job => ({
        title: job.title || "Java Developer",
        company:
          job.company?.name ||
          job.company?.display_name ||
          "Unknown",
        location: job.location || "India",
        experience: formatExperience(job.experience_level),
        "posted-at": job.published || new Date().toISOString(),
        category: "Java / Backend",
        fit_score: calculateFitScore(job),
        summary: createSummary(job),
        "why-match": createWhyMatch(job),
        "missing-skills": createMissingSkills(job),
        "apply-url": job.application_url,
        source: "CleanJobData"
      }));

    // SAFETY: Do not delete existing jobs if no usable jobs were found.
    if (newJobs.length === 0) {
      return res.status(200).json({
        success: true,
        cleared: false,
        inserted: 0,
        searched: allJobs.length,
        unique: uniqueJobs.length,
        relevant: filteredJobs.length,
        message:
          "No usable jobs were found. Existing Supabase jobs were preserved."
      });
    }

    // 9. Delete old jobs only after new jobs are prepared
    const deleteResponse = await fetch(
      `${supabaseRestUrl}/jobs?id=not.is.null`,
      {
        method: "DELETE",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
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

    // 10. Insert the latest unique jobs
    const insertResponse = await fetch(
      `${supabaseRestUrl}/jobs`,
      {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(newJobs)
      }
    );

    if (!insertResponse.ok) {
      const errorText = await insertResponse.text();

      return res.status(502).json({
        success: false,
        error: "Supabase insert failed after clearing old jobs",
        details: errorText
      });
    }

    // 11. Success response
    return res.status(200).json({
      success: true,
      searched: allJobs.length,
      unique: uniqueJobs.length,
      relevant: filteredJobs.length,
      deduplicated: deduplicatedFilteredJobs.length,
      duplicates_removed:
        filteredJobs.length - deduplicatedFilteredJobs.length,
      cleared: true,
      inserted: newJobs.length,
      message: "Previous jobs cleared and latest unique Java jobs added successfully"
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
    .replace(/\s+/g, " ")
    .trim();

  if (!description) {
    return `${job.title || "Java Developer"} opportunity at ${
      job.company?.name ||
      job.company?.display_name ||
      "the company"
    }.`;
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
