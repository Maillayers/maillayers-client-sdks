import React, { useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  MailLayersEmailEditor,
  type MailLayersEmailEditorRef,
} from "@maillayers/react-email-editor";

function App() {
  const editorRef = useRef<MailLayersEmailEditorRef>(null);

  return (
    <main style={{ height: "100vh", width: "100vw" }}>
      <div style={{ display: "flex", gap: 8, padding: 8 }}>
        <button
          type="button"
          onClick={async () => {
            const html = await editorRef.current?.getHtml();
            console.log("html", html?.length);
          }}
        >
          Get HTML
        </button>
        <button
          type="button"
          onClick={async () => {
            const json = await editorRef.current?.getJson();
            console.log("json", json);
          }}
        >
          Get JSON
        </button>
        <button type="button" onClick={() => editorRef.current?.reload()}>
          Reload
        </button>
      </div>
      <MailLayersEmailEditor
        ref={editorRef}
        apiKey={import.meta.env.VITE_MAILLAYERS_API_KEY}
        initialHtml="<h1>Hello from MailLayers</h1>"
        // exportUi={true} // optionally show hosted Export UI in embedded mode
        onSave={(html) => console.log("saved", html.length)}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
