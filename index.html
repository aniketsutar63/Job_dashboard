module.exports = async (req, res) => {
  try {
    const supabaseUrl = (
      process.env.NEXT_PUBLIC_SUPABASE_URL || ""
    )
      .trim()
      .replace(/\/+$/, "");

    const supabaseKey =
      process.env.SUPABASE_SECRET_KEY;

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

    const supabaseRestUrl =
      supabaseUrl.endsWith("/rest/v1")
        ? supabaseUrl
        : `${supabaseUrl}/rest/v1`;

    const response = await fetch(
      `${supabaseRestUrl}/jobs?select=*`,
      {
        method: "GET",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Accept: "application/json"
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      return res.status(502).json({
        success: false,
        error: "Supabase read failed",
        details: errorText
      });
    }

    const jobs = await response.json();

    if (!Array.isArray(jobs)) {
      return res.status(500).json({
        success: false,
        error: "Invalid jobs response from Supabase"
      });
    }

    jobs.sort((a, b) => {
      const dateA =
        new Date(a["posted-at"] || 0).getTime();

      const dateB =
        new Date(b["posted-at"] || 0).getTime();

      return dateB - dateA;
    });

    return res.status(200).json({
      success: true,
      count: jobs.length,
      jobs
    });

  } catch (error) {
    console.error("Job data API error:", error);

    return res.status(500).json({
      success: false,
      error:
        error.message || "Internal server error"
    });
  }
};
