# OpenAI plugin package

What OpenAI's plugin directory takes for ohmigo, in the Agent Plugins format: `plugin.json` (listing,
review test cases, publication), `mcp.json` (the one remote MCP server) and `assets/logo.png`.
Submitted at https://platform.openai.com/plugins.

To submit a version:

1. Fill `review.demo_recording_url` with a video of ohmigo working in ChatGPT, one a reviewer can
   open. The review refuses an empty one.
2. Raise `version`, and write what changed in `publication.release_notes`.
3. Zip the contents of this folder, not the folder:
   `cd directory/openai && zip -r ../../ohmigo-openai.zip plugin.json mcp.json assets`
4. Upload it. During MCP setup the portal gives a domain-verification token: set it as
   `OPENAI_APPS_CHALLENGE` in Zerops and restart the service, and the server answers it at
   `/.well-known/openai-apps-challenge`.

`publication.countries` is `[]`: no country restriction, so the plugin reaches every country where
ChatGPT offers plugins. `interface.category` must be one of the categories the dashboard lists.
Change it if the upload rejects it.

Credentials never go in the zip (the server needs none).
