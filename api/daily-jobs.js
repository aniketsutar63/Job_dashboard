module.exports = async (req, res) => {
  try {
    const cleanJobKey = process.env.CLEANJOBDATA_API_KEY;

    // Your actual Vercel variable name
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

    // --------------------------------------------------
    // Prepare Supabase REST URL
    // Handles both:
    // https://project.supabase.co
    // AND
    // https://project.supabase.co/rest/v1
    // --------------------------------------------------

    const supabaseUrl = rawSupabaseUrl
      .trim()
      .replace(/\/+$/, "");

    const supabaseRestUrl = supabaseUrl.endsWith("/rest/v1")
      ? supabaseUrl
      : `${supabaseUrl}/rest/v1`;

    // --------------------------------------------------
    // 1. Get Java jobs from CleanJobData
    // ONE API REQUEST
    // --------------------------------------------------

    const params = new URLSearchParams({
      title: "Java",
      country_id: "101",
      max_age: "24h",
      limit: "50",
      sort_by: "published",
      include_expired: "false",
      extra_fields: "description"
    });

    const response = await fetch(
      `https://api.cleanjobdata.com/jobs?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${cleanJobKey}`
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      return res.status(
        response.status === 429 ? 429 : 502
      ).json({
        success: false,
        error: `CleanJob API error: ${response.status}`,
        details: errorText
      });
    }

    const result = await response.json();

    const allJobs = Array.isArray(result.data)
      ? result.data
      : [];

    // --------------------------------------------------
    // 2. Remove duplicate jobs
    // --------------------------------------------------

    const uniqueJobs = Array.from(
      new Map(
        allJobs.map(job => [job.id, job])
      ).values()
    );

    // --------------------------------------------------
    // 3. Filter relevant India Java jobs
    // --------------------------------------------------

    const filteredJobs = uniqueJobs.filter(job => {
      if (job.is_active === false) {
        return false;
      }

      const title = (job.title || "").toLowerCase();
      const location = (job.location || "").toLowerCase();
      const description = (job.description || "").toLowerCase();

      // Must contain Java
      const hasJava =
        title.includes("java") ||
        description.includes("java");

      if (!hasJava) {
        return false;
      }

      // India locations
      const isIndia =
        location.includes("india") ||
        location.includes("pune") ||
        location.includes("bangalore") ||
        location.includes("bengaluru") ||
        location.includes("hyderabad") ||
        location.includes("mumbai") ||
        location.includes("delhi") ||
        location.includes("noida") ||
        location.includes("gurgaon") ||
        location.includes("gurugram") ||
        location.includes("chennai") ||
        location.includes("kolkata") ||
        location.includes("ahmedabad") ||
        location.includes("indore") ||
        location.includes("coimbatore");

      if (!isIndia) {
        return false;
      }

      // Relevant Java development roles
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

      if (!relevantRole) {
        return false;
      }

      // Exclude clearly senior roles
      const seniorRole =
        title.includes("senior") ||
        title.includes("sr.") ||
        title.includes("lead") ||
        title.includes("principal") ||
        title.includes("architect") ||
        title.includes("director") ||
        title.includes("manager") ||
        title.includes("head of");

      if (seniorRole) {
        return false;
      }

      return true;
    });

    // --------------------------------------------------
    // 4. Get existing jobs from Supabase
    // --------------------------------------------------

    const existingResponse = await fetch(
      `${supabaseRestUrl}/jobs?select=apply-url`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`
        }
      }
    );

    if (!existingResponse.ok) {
      const errorText = await existingResponse.text();

      return res.status(502).json({
        success: false,
        error: "Could not read existing Supabase jobs",
        details: errorText
      });
    }

    const existingJobs = await existingResponse.json();

    const existingUrls = new Set(
      existingJobs
        .map(job => job["apply-url"])
        .filter(Boolean)
    );

    // --------------------------------------------------
    // 5. Prepare only NEW jobs
    // --------------------------------------------------

    const newJobs = filteredJobs
      .filter(job => {
        const url = job.application_url;

        return url && !existingUrls.has(url);
      })
      .map(job => ({
        "created-at": new Date().toISOString(),

        title:
          job.title ||
          "Java Developer",

        company:
          job.company?.name ||
          job.company?.display_name ||
          "Unknown",

        location:
          job.location ||
          "India",

        experience:
          formatExperience(
            job.experience_level
          ),

        "posted-at":
          job.published ||
          new Date().toISOString(),

        category:
          "Java",

        fit_score:
          calculateFitScore(job),

        summary:
          createSummary(job),

        "why-match":
          createWhyMatch(job),

        "missing-skills":
          createMissingSkills(job),

        "apply-url":
          job.application_url,

        source:
          "CleanJobData"
      }));

    // --------------------------------------------------
    // 6. Insert new jobs into Supabase
    // --------------------------------------------------

    if (newJobs.length > 0) {
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
        const errorText =
          await insertResponse.text();

        return res.status(502).json({
          success: false,
          error: "Supabase insert failed",
          details: errorText
        });
      }
    }

    // --------------------------------------------------
    // 7. Success response
    // --------------------------------------------------

    return res.status(200).json({
      success: true,

      searched:
        allJobs.length,

      unique:
        uniqueJobs.length,

      filtered:
        filteredJobs.length,

      inserted:
        newJobs.length,

      message:
        "Daily Java job update completed"
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};


// --------------------------------------------------
// Format experience
// --------------------------------------------------

function formatExperience(level) {
  if (!level) {
    return "0–3 years";
  }

  const value = String(level).toUpperCase();

  if (value === "EN") {
    return "Entry Level";
  }

  if (value === "MI") {
    return "Mid Level";
  }

  if (value === "SE") {
    return "Senior";
  }

  if (value === "EX") {
    return "Executive";
  }

  return level;
}


// --------------------------------------------------
// Calculate fit score
// --------------------------------------------------

function calculateFitScore(job) {
  const text = `
    ${job.title || ""}
    ${job.description || ""}
    ${job.experience_level || ""}
  `.toLowerCase();

  let score = 60;

  if (text.includes("java")) {
    score += 10;
  }

  if (text.includes("spring boot")) {
    score += 10;
  }

  if (text.includes("spring")) {
    score += 5;
  }

  if (text.includes("rest")) {
    score += 5;
  }

  if (text.includes("hibernate")) {
    score += 3;
  }

  if (text.includes("mysql")) {
    score += 2;
  }

  if (text.includes("react")) {
    score += 2;
  }

  if (text.includes("git")) {
    score += 1;
  }

  if (text.includes("maven")) {
    score += 1;
  }

  return Math.min(score, 100);
}


// --------------------------------------------------
// Create job summary
// --------------------------------------------------

function createSummary(job) {
  const description =
    (job.description || "")
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


// --------------------------------------------------
// Why this job matches
// --------------------------------------------------

function createWhyMatch(job) {
  const text = `
    ${job.title || ""}
    ${job.description || ""}
  `.toLowerCase();

  const matches = [];

  if (text.includes("java")) {
    matches.push("Java");
  }

  if (text.includes("spring boot")) {
    matches.push("Spring Boot");
  }

  if (text.includes("rest")) {
    matches.push("REST APIs");
  }

  if (
    text.includes("sql") ||
    text.includes("mysql")
  ) {
    matches.push("SQL/MySQL");
  }

  if (text.includes("react")) {
    matches.push("React");
  }

  if (
    text.includes("hibernate") ||
    text.includes("jpa")
  ) {
    matches.push("Hibernate/JPA");
  }

  if (matches.length === 0) {
    return "Matches the user's Java development profile.";
  }

  return `Matches profile skills: ${matches.join(", ")}.`;
}


// --------------------------------------------------
// Missing skills
// --------------------------------------------------

function createMissingSkills(job) {
  const text = `
    ${job.title || ""}
    ${job.description || ""}
  `.toLowerCase();

  const missing = [];

  if (!text.includes("docker")) {
    missing.push("Docker");
  }

  if (!text.includes("kubernetes")) {
    missing.push("Kubernetes");
  }

  if (!text.includes("aws")) {
    missing.push("AWS");
  }

  if (!text.includes("microservices")) {
    missing.push("Microservices");
  }

  return missing.join(", ");
}
