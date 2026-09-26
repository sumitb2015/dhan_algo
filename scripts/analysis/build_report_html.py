import re
import os

source_md = '/home/sumit/.gemini/antigravity-cli/brain/09fc2bf8-c532-4a48-86d6-bddfd535310b/nifty_straddle_1year_backtest_report_with_trades.md'
target_dir = 'debug/backtests/options/nifty_straddle_10diff_20sl_shift'
os.makedirs(target_dir, exist_ok=True)

with open(source_md, 'r') as f:
    md_content = f.read()

# Copy report.md to target_dir
with open(os.path.join(target_dir, 'report.md'), 'w') as f:
    f.write(md_content)

html_template = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NIFTY 50 Intraday Straddle: 1-Year Quantitative Backtest Report</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --card-border: #1f2937;
      --text: #e2e8f0;
      --text-muted: #94a3b8;
      --accent: #54b4c7;
      --accent-hover: #38bdf8;
      --green: #10b981;
      --red: #ef4444;
      --amber: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      line-height: 1.6;
      padding: 2rem 1.5rem;
      font-size: 14px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--card-border);
      flex-wrap: wrap;
      gap: 1rem;
    }
    .title-group h1 {
      font-size: 1.75rem;
      font-weight: 800;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.6rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge-cyan { background: rgba(84, 180, 199, 0.15); color: #54b4c7; border: 1px solid rgba(84, 180, 199, 0.3); }
    .badge-green { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-amber { background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); }
    
    .actions {
      display: flex;
      gap: 0.75rem;
    }
    .btn {
      padding: 0.45rem 1rem;
      border-radius: 0.5rem;
      font-size: 0.75rem;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      transition: all 0.2s;
    }
    .btn-primary {
      background: var(--accent);
      color: #fff;
      border: 1px solid var(--accent);
    }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-outline {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text);
      border: 1px solid var(--card-border);
    }
    .btn-outline:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }

    /* Markdown Styling */
    #content h1 { font-size: 1.6rem; color: #fff; margin: 1.5rem 0 1rem; }
    #content h2 { font-size: 1.3rem; color: #fff; margin: 2rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--card-border); }
    #content h3 { font-size: 1.1rem; color: #38bdf8; margin: 1.5rem 0 0.75rem; }
    #content p { margin-bottom: 1rem; color: #cbd5e1; }
    #content hr { border: 0; border-top: 1px solid var(--card-border); margin: 2rem 0; }
    #content strong { color: #fff; }
    #content em { color: var(--text-muted); }

    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.5rem 0;
      font-size: 0.8rem;
      border-radius: 0.5rem;
      overflow: hidden;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
      background: var(--card-bg);
      border: 1px solid var(--card-border);
    }
    th {
      background: #1e293b;
      color: #f8fafc;
      padding: 0.65rem 0.75rem;
      font-weight: 700;
      text-align: left;
      border-bottom: 1px solid var(--card-border);
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    td {
      padding: 0.55rem 0.75rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      color: #cbd5e1;
    }
    tr:nth-child(even) { background: rgba(255, 255, 255, 0.02); }
    tr:hover { background: rgba(56, 189, 248, 0.06); }
    
    /* Code & Pre */
    code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      background: rgba(15, 23, 42, 0.8);
      padding: 0.15rem 0.4rem;
      border-radius: 0.25rem;
      color: #38bdf8;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    pre {
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 0.5rem;
      padding: 1rem;
      overflow-x: auto;
      margin: 1.5rem 0;
    }
    pre code { background: none; padding: 0; border: none; }

    /* Alerts */
    blockquote {
      background: rgba(15, 23, 42, 0.6);
      border-left: 4px solid var(--accent);
      padding: 1rem 1.25rem;
      margin: 1.5rem 0;
      border-radius: 0 0.5rem 0.5rem 0;
      color: #e2e8f0;
    }
    blockquote p { margin-bottom: 0.5rem; }
    blockquote p:last-child { margin-bottom: 0; }

    /* Mermaid */
    .mermaid {
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin: 1.5rem 0;
      display: flex;
      justify-content: center;
    }

    /* Search Box for table */
    .table-search-bar {
      margin: 1rem 0;
      display: flex;
      gap: 0.75rem;
      align-items: center;
    }
    .table-search-bar input {
      background: #0f172a;
      border: 1px solid var(--card-border);
      color: #fff;
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      font-size: 0.8rem;
      width: 320px;
    }
    .table-search-bar input:focus {
      outline: none;
      border-color: var(--accent);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <div class="title-group">
        <h1>NIFTY 50 Intraday Straddle Backtest Report</h1>
        <div style="margin-top: 0.4rem; display: flex; gap: 0.5rem; align-items: center;">
          <span class="badge badge-cyan">1-Year Full Simulation</span>
          <span class="badge badge-green">SEBI 2025 Tuesday Expiry</span>
          <span class="badge badge-amber">Dhan Ledger Audited</span>
        </div>
      </div>
      <div class="actions">
        <a href="trades.csv" download class="btn btn-outline">⬇ Download Trades CSV</a>
        <a href="tearsheet.html" target="_blank" class="btn btn-primary">📊 Open Interactive Tearsheet</a>
      </div>
    </div>

    <div id="content"></div>
  </div>

  <script>
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        darkMode: true,
        background: '#0f172a',
        primaryColor: '#1e293b',
        primaryTextColor: '#f8fafc',
        primaryBorderColor: '#38bdf8',
        lineColor: '#54b4c7',
        secondaryColor: '#1e293b',
        tertiaryColor: '#0f172a'
      }
    });

    const rawMarkdown = __MARKDOWN_RAW__;

    // Custom renderer for mermaid code blocks
    const renderer = new marked.Renderer();
    const defaultCodeRenderer = renderer.code.bind(renderer);

    renderer.code = function(code, language) {
      if (language === 'mermaid') {
        return '<div class="mermaid">' + code.text + '</div>';
      }
      return defaultCodeRenderer(code, language);
    };

    marked.setOptions({
      renderer: renderer,
      breaks: true,
      gfm: true
    });

    document.getElementById('content').innerHTML = marked.parse(rawMarkdown);
    mermaid.run();
  </script>
</body>
</html>
"""

# Inject markdown safely into HTML
import json
safe_json_md = json.dumps(md_content)
final_html = html_template.replace('__MARKDOWN_RAW__', safe_json_md)

with open(os.path.join(target_dir, 'report.html'), 'w') as f:
    f.write(final_html)

print("Generated report.html and report.md in", target_dir)
