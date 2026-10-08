module.exports = async (req, res) => {
  try {
    // ==================================================
    // 1. Environment Variables
    // ==================================================

    const cleanJobKey = process.env.CLEANJOBDATA_API_KEY;
    const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "")
      .trim()
      .replace(/\/+$/, "");

    const supabaseKey = process.env.SUPABASE_SECRET_KEY;

    if (!cleanJobKey) {
      return res.status(500).json({
        success: false,
        error: "CLEANJOBDATA_API_KEY is missing"
      });
    }

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        success: false,
        error: "Supabase environment variables are missing",
        supabaseUrlFound: !!supabaseUrl,
        supabaseKeyFound: !!supabaseKey
      });
    }

    const supabaseRestUrl = supabaseUrl.endsWith("/rest/v1")
      ? supabaseUrl
      : `${supabaseUrl}/rest/v1`;


    // ==================================================
    // 2. Get NEW Java Jobs from CleanJobData
    // ==================================================

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

    const cleanJobResponse = await fetch(
      `https://api.cleanjobdata.com/jobs?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cleanJobKey}`,
          Accept: "application/json"
        }
      }
    );

    if (!cleanJobResponse.ok) {
      const errorText = await cleanJobResponse.text();

      return res.status(
        cleanJobResponse.status === 429 ? 429 : 502
      ).json({
        success: false,
        error: `CleanJobData API error: ${cleanJobResponse.status}`,
        details: errorText
      });
    }

    const result = await cleanJobResponse.json();

    const allJobs = Array.isArray(result.data)
      ? result.data
      : [];


    // ==================================================
    // 3. Remove Duplicate API Results
    // ==================================================

    const uniqueJobs = Array.from(
      new Map(
        allJobs.map(job => [job.id, job])
      ).values()
    );


    // ==================================================
    // 4. Filter Jobs for YOUR Profile
    // ==================================================

    const filteredJobs = uniqueJobs.filter(job => {
      if (!job || job.is_active === false) {
        return false;
      }

      const title = String(job.title || "").toLowerCase();

      const description = String(
        job.description || ""
      ).toLowerCase();

      const location = String(
        job.location || ""
      ).toLowerCase();


      // --------------------------------------------------
      // Java requirement
      // --------------------------------------------------

      const javaRelated =
        title.includes("java") ||
        description.includes("java");

      if (!javaRelated) {
        return false;
      }


      // --------------------------------------------------
      // Target job titles
      // --------------------------------------------------

      const targetRole =
        title.includes("java developer") ||
        title.includes("java engineer") ||
        title.includes("java software engineer") ||
        title.includes("java backend") ||
        title.includes("backend developer") ||
        title.includes("backend engineer") ||
        title.includes("full stack java") ||
        title.includes("java full stack") ||
        title.includes("software developer") ||
        title.includes("software engineer") ||
        title.includes("associate software engineer") ||
        title.includes("associate developer") ||
        title.includes("junior java") ||
        title.includes("application developer");

      if (!targetRole) {
        return false;
      }


      // --------------------------------------------------
      // Exclude senior / lead / management positions
      // --------------------------------------------------

      const excludedRole =
        title.includes("senior") ||
        title.includes("sr.") ||
        title.includes("sr ") ||
        title.includes("lead") ||
        title.includes("principal") ||
        title.includes("architect") ||
        title.includes("manager") ||
        title.includes("director") ||
        title.includes("head of") ||
        title.includes("staff engineer") ||
        title.includes("expert");

      if (excludedRole) {
        return false;
      }


      // --------------------------------------------------
      // Location
      //
      // Keep:
      // Pune
      // Remote
      // Hybrid
      // India
      // --------------------------------------------------

      const isPune =
        location.includes("pune");

      const isRemote =
        job.has_remote === true ||
        location.includes("remote") ||
        String(job.remote_type || "").length > 0;

      const isIndia =
        location.includes("india") ||
        location.includes("pune") ||
        location.includes("mumbai") ||
        location.includes("bangalore") ||
        location.includes("bengaluru") ||
        location.includes("hyderabad") ||
        location.includes("chennai") ||
        location.includes("delhi") ||
        location.includes("noida") ||
        location.includes("gurgaon") ||
        location.includes("gurugram") ||
        location.includes("kolkata") ||
        location.includes("ahmedabad") ||
        location.includes("indore");

      // Accept Pune, Remote or Indian locations
      if (!isPune && !isRemote && !isIndia) {
        return false;
      }


      // --------------------------------------------------
      // Extra check for completely unrelated roles
      // --------------------------------------------------

      const unrelated =
        title.includes("php") ||
        title.includes(".net") ||
        title.includes("python developer") ||
        title.includes("data scientist") ||
        title.includes("devops engineer") ||
        title.includes("network engineer") ||
        title.includes("qa engineer") ||
        title.includes("test engineer") ||
        title.includes("embedded engineer") ||
        title.includes("hardware engineer");

      if (unrelated) {
        return false;
      }

      return true;
    });


    // ==================================================
    // 5. Read Existing Jobs from Supabase
    // ==================================================

    const existingResponse = await fetch(
      `${supabaseRestUrl}/jobs?select=id,apply_url`,
      {
        method: "GET",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Accept: "application/json"
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

    const existingIds = new Set(
      existingJobs
        .map(job => Number(job.id))
        .filter(Boolean)
    );

    const existingUrls = new Set(
      existingJobs
        .map(job => job.apply_url)
        .filter(Boolean)
    );


    // ==================================================
    // 6. Prepare New Jobs
    // ==================================================

    const newJobs = filteredJobs
      .filter(job => {
        const jobId = Number(job.id);
        const applicationUrl = job.application_url;

        // Don't insert duplicates
        if (existingIds.has(jobId)) {
          return false;
        }

        if (
          applicationUrl &&
          existingUrls.has(applicationUrl)
        ) {
          return false;
        }

        return true;
      })
      .map(job => ({
        // DO NOT insert created_at.
        // Supabase automatically creates it.

        title:
          job.title ||
          "Java Developer",

        company:
          job.company?.name ||
          job.company?.display_name ||
          "Company Not Specified",

        location:
          job.location ||
          "India",

        experience:
          formatExperience(
            job.experience_level
          ),

        posted_at:
          job.published ||
          new Date().toISOString(),

        category:
          "Java / Backend",

        fit_score:
          calculateFitScore(job),

        summary:
          createSummary(job),

        why_match:
          createWhyMatch(job),

        missing_skills:
          createMissingSkills(job),

        apply_url:
          job.application_url ||
          "",

        source:
          "CleanJobData"
      }));


    // ==================================================
    // 7. Insert New Jobs into Supabase
    // ==================================================

    let insertedCount = 0;

    if (newJobs.length > 0) {
      const insertResponse = await fetch(
        `${supabaseRestUrl}/jobs`,
        {
          method: "POST",

          headers: {
            apikey: supabaseKey,

            Authorization:
              `Bearer ${supabaseKey}`,

            "Content-Type":
              "application/json",

            Prefer:
              "return=minimal"
          },

          body:
            JSON.stringify(newJobs)
        }
      );

      if (!insertResponse.ok) {
        const errorText =
          await insertResponse.text();

        return res.status(502).json({
          success: false,
          error: "Supabase insert failed",
          details: errorText,
          jobsPrepared: newJobs.length
        });
      }

      insertedCount = newJobs.length;
    }


    // ==================================================
    // 8. Final Response
    // ==================================================

    return res.status(200).json({
      success: true,

      searched:
        allJobs.length,

      unique:
        uniqueJobs.length,

      relevant:
        filteredJobs.length,

      prepared:
        newJobs.length,

      inserted:
        insertedCount,

      message:
        insertedCount > 0
          ? "New Java jobs added successfully"
          : "No new matching Java jobs found in the last 24 hours"
    });

  } catch (error) {

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};


// ======================================================
// EXPERIENCE
// ======================================================

function formatExperience(level) {

  if (!level) {
    return "0–3 years";
  }

  const value =
    String(level).toUpperCase();

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


// ======================================================
// FIT SCORE
// ======================================================

function calculateFitScore(job) {

  const text = `
    ${job.title || ""}
    ${job.description || ""}
  `.toLowerCase();

  let score = 50;


  if (text.includes("java")) {
    score += 15;
  }

  if (text.includes("spring boot")) {
    score += 10;
  }

  if (
    text.includes("spring framework") ||
    text.includes("spring mvc")
  ) {
    score += 5;
  }

  if (
    text.includes("rest api") ||
    text.includes("restful")
  ) {
    score += 5;
  }

  if (
    text.includes("mysql") ||
    text.includes("sql")
  ) {
    score += 4;
  }

  if (
    text.includes("hibernate") ||
    text.includes("jpa")
  ) {
    score += 3;
  }

  if (
    text.includes("spring security") ||
    text.includes("jwt")
  ) {
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


// ======================================================
// SUMMARY
// ======================================================

function createSummary(job) {

  const description =
    String(job.description || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  if (!description) {
    return `${job.title || "Java Developer"} opportunity at ${
      job.company?.name ||
      "the company"
    }.`;
  }

  return description.substring(0, 500);
}


// ======================================================
// WHY MATCH
// ======================================================

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

  if (
    text.includes("rest api") ||
    text.includes("restful")
  ) {
    matches.push("REST APIs");
  }

  if (
    text.includes("mysql") ||
    text.includes("sql")
  ) {
    matches.push("SQL/MySQL");
  }

  if (
    text.includes("hibernate") ||
    text.includes("jpa")
  ) {
    matches.push("Hibernate/JPA");
  }

  if (
    text.includes("spring security") ||
    text.includes("jwt")
  ) {
    matches.push("Spring Security/JWT");
  }

  if (text.includes("react")) {
    matches.push("React");
  }

  if (text.includes("git")) {
    matches.push("Git");
  }


  if (matches.length === 0) {
    return "Matches the Java development profile.";
  }

  return `Matches profile skills: ${matches.join(", ")}.`;
}


// ======================================================
// MISSING SKILLS
// ======================================================

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

  if (!text.includes("junit")) {
    missing.push("JUnit");
  }

  if (!text.includes("kafka")) {
    missing.push("Kafka");
  }

  return missing.join(", ");
}
