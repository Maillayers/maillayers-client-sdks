import React from "react";
import { createRoot } from "react-dom/client";
import { MailLayersEmailEditor } from "@maillayers/react-email-editor";

function App() {
  return (
    <main style={{ height: "100vh", width: "100vw" }}>
      <MailLayersEmailEditor
        apiKey={import.meta.env.VITE_MAILLAYERS_API_KEY}
        initialHtml="<h1>Hello from MailLayers</h1>"
        onSave={(html) => console.log("saved", html.length)}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
