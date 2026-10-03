module.exports = async (req, res) => {
  try {
    const cleanJobKey = process.env.CLEANJOBDATA_API_KEY;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;

    if (!cleanJobKey) {
      return res.status(500).json({
        success: false,
        error: "CLEANJOBDATA_API_KEY is missing"
      });
    }

    // Check Supabase environment variables
    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        success: false,
        error: "Supabase environment variables are missing",
        supabaseUrlFound: !!supabaseUrl,
        supabaseKeyFound: !!supabaseKey
      });
    }

    const keywords = [
      "Java Developer",
      "Java Backend Developer",
      "Spring Boot Developer",
      "Software Developer",
      "Full Stack Java Developer",
      "Backend Developer",
      "Associate Java Developer",
      "Junior Java Developer"
    ];

    const allJobs = [];

    for (const keyword of keywords) {
      const params = new URLSearchParams({
        title: keyword,
        country_id: "101",
        max_age: "24h",
        limit: "20",
        sort_by: "published",
        include_expired: "false"
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

        return res.status(502).json({
          success: false,
          error: `CleanJob API error: ${response.status}`,
          details: errorText
        });
      }

      const result = await response.json();

      if (Array.isArray(result.data)) {
        allJobs.push(...result.data);
      }
    }

    // Remove duplicate jobs
    const uniqueJobs = Array.from(
      new Map(allJobs.map(job => [job.id, job])).values()
    );

    // Keep only active India jobs
    const filteredJobs = uniqueJobs.filter(job => {
      if (job.is_active === false) return false;

      const location = (job.location || "").toLowerCase();

      return (
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
        location.includes("chennai")
      );
    });

    // Get existing application URLs to avoid duplicates
    const existingResponse = await fetch(
      `${supabaseUrl}/rest/v1/jobs?select=apply-url`,
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

    const newJobs = filteredJobs
      .filter(job => {
        const url = job.application_url;

        return url && !existingUrls.has(url);
      })
      .map(job => ({
        "created-at": new Date().toISOString(),
        title: job.title || "Java Developer",
        company: job.company?.name || "Unknown",
        location: job.location || "India",
        experience: job.experience_level || "0–3 years",
        "posted-at": job.published || new Date().toISOString(),
        category: "Java",
        fit_score: calculateFitScore(job),
        summary: createSummary(job),
        "why-match": createWhyMatch(job),
        "missing-skills": createMissingSkills(job),
        "apply-url": job.application_url,
        source: "CleanJobData"
      }));

    // Insert new jobs into Supabase
    if (newJobs.length > 0) {
      const insertResponse = await fetch(
        `${supabaseUrl}/rest/v1/jobs`,
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
          error: "Supabase insert failed",
          details: errorText
        });
      }
    }

    return res.status(200).json({
      success: true,
      searched: allJobs.length,
      unique: uniqueJobs.length,
      filtered: filteredJobs.length,
      inserted: newJobs.length,
      message: "Daily Java job update completed"
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};


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


function createSummary(job) {
  const description = (job.description || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return description.substring(0, 500);
}


function createWhyMatch(job) {
  return "Matches Aniket's Java/Spring Boot, REST API, SQL, backend and full-stack development profile.";
}


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
