"use client";

import { MailLayersEmailEditor } from "@maillayers/react-email-editor";

export default function EditorPage() {
  return (
    <main style={{ height: "100vh", width: "100vw" }}>
      <MailLayersEmailEditor
        apiKey={process.env.NEXT_PUBLIC_MAILLAYERS_API_KEY}
        initialHtml="<h1>Hello from MailLayers</h1>"
        onSave={(html) => console.log("saved", html.length)}
      />
    </main>
  );
}
