module.exports = async (req, res) => {
  try {
    const supabaseUrl =
      (process.env.NEXT_PUBLIC_SUPABASE_URL || "")
        .trim()
        .replace(/\/+$/, "");

    const supabaseKey =
      process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        success: false,
        error: "Supabase environment variables are missing"
      });
    }

    const supabaseRestUrl =
      supabaseUrl.endsWith("/rest/v1")
        ? supabaseUrl
        : `${supabaseUrl}/rest/v1`;

    const response = await fetch(
      `${supabaseRestUrl}/jobs?select=*&order=posted-at.desc`,
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

    return res.status(200).json({
      success: true,
      count: jobs.length,
      jobs: jobs
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
