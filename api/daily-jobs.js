module.exports = async (req, res) => {
  try {

    // =====================================================
    // 1. ENVIRONMENT VARIABLES
    // =====================================================

    const cleanJobKey =
      process.env.CLEANJOBDATA_API_KEY;

    const rawSupabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL;

    const supabaseKey =
      process.env.SUPABASE_SECRET_KEY;


    if (!cleanJobKey) {
      return res.status(500).json({
        success: false,
        error:
          "CLEANJOBDATA_API_KEY is missing"
      });
    }


    if (!rawSupabaseUrl || !supabaseKey) {
      return res.status(500).json({
        success: false,
        error:
          "Supabase environment variables are missing",
        supabaseUrlFound:
          !!rawSupabaseUrl,
        supabaseKeyFound:
          !!supabaseKey
      });
    }


    // =====================================================
    // 2. SUPABASE REST URL
    // =====================================================

    const supabaseUrl =
      rawSupabaseUrl
        .trim()
        .replace(/\/+$/, "");


    const supabaseRestUrl =
      supabaseUrl.endsWith("/rest/v1")
        ? supabaseUrl
        : `${supabaseUrl}/rest/v1`;


    // =====================================================
    // 3. GET LATEST JAVA JOBS FROM CLEANJOBDATA
    // =====================================================

    const params =
      new URLSearchParams({
        country_id: "101",
        title: "Java",
        experience_level: "EN,MI",
        created_max_age: "24h",
        limit: "20",
        sort_by: "published",
        include_expired: "false",
        extra_fields: "description"
      });


    const response =
      await fetch(
        `https://api.cleanjobdata.com/jobs?${params.toString()}`,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${cleanJobKey}`
          }
        }
      );


    // =====================================================
    // 4. CLEANJOBDATA ERROR
    // =====================================================

    if (!response.ok) {

      const errorText =
        await response.text();


      return res.status(
        response.status === 429
          ? 429
          : 502
      ).json({

        success: false,

        error:
          `CleanJob API error: ${response.status}`,

        details:
          errorText

      });

    }


    // =====================================================
    // 5. READ CLEANJOBDATA RESPONSE
    // =====================================================

    const result =
      await response.json();


    if (
      !result ||
      !Array.isArray(result.data)
    ) {

      return res.status(502).json({

        success: false,

        error:
          "CleanJobData returned an invalid response"

      });

    }


    const allJobs =
      result.data;


    // =====================================================
    // 6. REMOVE DUPLICATE CLEANJOBDATA JOBS
    // =====================================================

    const uniqueJobs =
      Array.from(

        new Map(

          allJobs.map(
            job => [
              job.id,
              job
            ]
          )

        ).values()

      );


    // =====================================================
    // 7. FILTER RELEVANT JOBS
    // =====================================================

    const filteredJobs =
      uniqueJobs.filter(
        job => {

          // -----------------------------------------------
          // Active jobs only
          // -----------------------------------------------

          if (
            job.is_active === false
          ) {
            return false;
          }


          const title =
            (
              job.title || ""
            ).toLowerCase();


          const location =
            (
              job.location || ""
            ).toLowerCase();


          const description =
            (
              job.description || ""
            ).toLowerCase();


          // -----------------------------------------------
          // Java requirement
          // -----------------------------------------------

          const hasJava =
            title.includes("java") ||
            description.includes("java");


          if (!hasJava) {
            return false;
          }


          // -----------------------------------------------
          // India locations
          // -----------------------------------------------

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


          // -----------------------------------------------
          // Relevant role
          // -----------------------------------------------

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


          // -----------------------------------------------
          // Exclude senior / lead positions
          // -----------------------------------------------

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

        }
      );


    // =====================================================
    // 8. PREPARE NEW JOB DATA
    // =====================================================

    const newJobs =
      filteredJobs
        .filter(
          job =>
            !!job.application_url
        )
        .map(
          job => ({

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
              "Java / Backend",


            fit_score:
              calculateFitScore(
                job
              ),


            summary:
              createSummary(
                job
              ),


            "why-match":
              createWhyMatch(
                job
              ),


            "missing-skills":
              createMissingSkills(
                job
              ),


            "apply-url":
              job.application_url,


            source:
              "CleanJobData"

          })
        );


    // =====================================================
    // 9. DELETE PREVIOUS JOBS
    //
    // IMPORTANT:
    // This happens only AFTER CleanJobData succeeds
    // and the new jobs have been prepared.
    // =====================================================

    const deleteResponse =
      await fetch(
        `${supabaseRestUrl}/jobs?id=not.is.null`,
        {
          method: "DELETE",

          headers: {
            apikey:
              supabaseKey,

            Authorization:
              `Bearer ${supabaseKey}`,

            Accept:
              "application/json"
          }
        }
      );


    if (!deleteResponse.ok) {

      const errorText =
        await deleteResponse.text();


      return res.status(502).json({

        success: false,

        error:
          "Could not clear previous jobs",

        details:
          errorText

      });

    }


    // =====================================================
    // 10. INSERT TODAY'S JOBS
    // =====================================================

    if (
      newJobs.length > 0
    ) {

      const insertResponse =
        await fetch(
          `${supabaseRestUrl}/jobs`,
          {
            method: "POST",

            headers: {

              apikey:
                supabaseKey,

              Authorization:
                `Bearer ${supabaseKey}`,

              "Content-Type":
                "application/json",

              Prefer:
                "return=representation"

            },

            body:
              JSON.stringify(
                newJobs
              )

          }
        );


      if (
        !insertResponse.ok
      ) {

        const errorText =
          await insertResponse.text();


        return res.status(502).json({

          success: false,

          error:
            "Supabase insert failed after clearing old jobs",

          details:
            errorText

        });

      }

    }


    // =====================================================
    // 11. SUCCESS
    // =====================================================

    return res.status(200).json({

      success: true,

      searched:
        allJobs.length,

      unique:
        uniqueJobs.length,

      relevant:
        filteredJobs.length,

      cleared:
        true,

      inserted:
        newJobs.length,

      message:
        "Previous jobs cleared and latest Java jobs added successfully"

    });


  } catch (error) {

    console.error(
      "Daily jobs error:",
      error
    );


    return res.status(500).json({

      success: false,

      error:
        error.message ||
        "Internal server error"

    });

  }
};


// =====================================================
// FORMAT EXPERIENCE
// =====================================================

function formatExperience(
  level
) {

  if (!level) {
    return "0–3 years";
  }


  const value =
    String(level)
      .toUpperCase();


  if (
    value === "EN"
  ) {
    return "Entry Level";
  }


  if (
    value === "MI"
  ) {
    return "Mid Level";
  }


  if (
    value === "SE"
  ) {
    return "Senior";
  }


  if (
    value === "EX"
  ) {
    return "Executive";
  }


  return level;

}


// =====================================================
// FIT SCORE
// =====================================================

function calculateFitScore(
  job
) {

  const text = `

    ${job.title || ""}

    ${job.description || ""}

    ${job.experience_level || ""}

  `.toLowerCase();


  let score = 60;


  if (
    text.includes("java")
  ) {
    score += 10;
  }


  if (
    text.includes("spring boot")
  ) {
    score += 10;
  }


  if (
    text.includes("spring")
  ) {
    score += 5;
  }


  if (
    text.includes("rest")
  ) {
    score += 5;
  }


  if (
    text.includes("hibernate")
  ) {
    score += 3;
  }


  if (
    text.includes("mysql")
  ) {
    score += 2;
  }


  if (
    text.includes("react")
  ) {
    score += 2;
  }


  if (
    text.includes("git")
  ) {
    score += 1;
  }


  if (
    text.includes("maven")
  ) {
    score += 1;
  }


  return Math.min(
    score,
    100
  );

}


// =====================================================
// SUMMARY
// =====================================================

function createSummary(
  job
) {

  const description =
    (
      job.description || ""
    )
      .replace(
        /<[^>]*>/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();


  if (!description) {

    return `${
      job.title ||
      "Java Developer"
    } opportunity at ${
      job.company?.name ||
      job.company?.display_name ||
      "the company"
    }.`;

  }


  return description.substring(
    0,
    500
  );

}


// =====================================================
// WHY MATCH
// =====================================================

function createWhyMatch(
  job
) {

  const text = `

    ${job.title || ""}

    ${job.description || ""}

  `.toLowerCase();


  const matches = [];


  if (
    text.includes("java")
  ) {
    matches.push("Java");
  }


  if (
    text.includes("spring boot")
  ) {
    matches.push("Spring Boot");
  }


  if (
    text.includes("rest")
  ) {
    matches.push("REST APIs");
  }


  if (
    text.includes("sql") ||
    text.includes("mysql")
  ) {
    matches.push("SQL/MySQL");
  }


  if (
    text.includes("react")
  ) {
    matches.push("React");
  }


  if (
    text.includes("hibernate") ||
    text.includes("jpa")
  ) {
    matches.push("Hibernate/JPA");
  }


  if (
    matches.length === 0
  ) {

    return "Matches the user's Java development profile.";

  }


  return `Matches profile skills: ${matches.join(
    ", "
  )}.`;

}


// =====================================================
// MISSING SKILLS
// =====================================================

function createMissingSkills(
  job
) {

  const text = `

    ${job.title || ""}

    ${job.description || ""}

  `.toLowerCase();


  const missing = [];


  if (
    !text.includes("docker")
  ) {
    missing.push("Docker");
  }


  if (
    !text.includes("kubernetes")
  ) {
    missing.push("Kubernetes");
  }


  if (
    !text.includes("aws")
  ) {
    missing.push("AWS");
  }


  if (
    !text.includes("microservices")
  ) {
    missing.push("Microservices");
  }


  return missing.join(
    ", "
  );

}
