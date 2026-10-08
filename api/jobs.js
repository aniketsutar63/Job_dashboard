module.exports = async (req, res) => {
  try {
    // =====================================================
    // SUPABASE CONFIGURATION
    // =====================================================

    const supabaseUrl = (
      process.env.NEXT_PUBLIC_SUPABASE_URL || ""
    )
      .trim()
      .replace(/\/+$/, "");

    const supabaseKey =
      process.env.SUPABASE_SECRET_KEY;


    // =====================================================
    // CHECK ENVIRONMENT VARIABLES
    // =====================================================

    if (!supabaseUrl) {
      return res.status(500).json({
        success: false,
        error: "NEXT_PUBLIC_SUPABASE_URL is missing"
      });
    }


    if (!supabaseKey) {
      return res.status(500).json({
        success: false,
        error: "SUPABASE_SECRET_KEY is missing"
      });
    }


    // =====================================================
    // SUPABASE REST URL
    // =====================================================

    const supabaseRestUrl =
      supabaseUrl.endsWith("/rest/v1")
        ? supabaseUrl
        : `${supabaseUrl}/rest/v1`;


    // =====================================================
    // READ JOBS FROM SUPABASE
    // =====================================================

    const query = new URLSearchParams({
      select: "*"
    });


    const response = await fetch(
      `${supabaseRestUrl}/jobs?${query.toString()}`,
      {
        method: "GET",

        headers: {
          apikey: supabaseKey,

          Authorization:
            `Bearer ${supabaseKey}`,

          Accept:
            "application/json"
        }
      }
    );


    // =====================================================
    // HANDLE SUPABASE ERROR
    // =====================================================

    if (!response.ok) {

      const errorText =
        await response.text();

      return res.status(502).json({
        success: false,

        error:
          "Supabase job read failed",

        details:
          errorText
      });

    }


    // =====================================================
    // GET JOB DATA
    // =====================================================

    const jobs =
      await response.json();


    // =====================================================
    // MAKE SURE RESPONSE IS ARRAY
    // =====================================================

    if (!Array.isArray(jobs)) {

      return res.status(500).json({
        success: false,

        error:
          "Supabase returned invalid job data"
      });

    }


    // =====================================================
    // SORT BY POSTED DATE
    // =====================================================

    jobs.sort(
      (a, b) => {

        const dateA =
          new Date(
            a["posted-at"] || 0
          ).getTime();


        const dateB =
          new Date(
            b["posted-at"] || 0
          ).getTime();


        return dateB - dateA;

      }
    );


    // =====================================================
    // RETURN JOBS
    // =====================================================

    return res.status(200).json({

      success: true,

      count:
        jobs.length,

      jobs:
        jobs

    });


  } catch (error) {

    console.error(
      "Jobs API error:",
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
