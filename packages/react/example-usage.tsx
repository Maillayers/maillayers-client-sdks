import React, { useState } from 'react';
import { MailLayersEmailEditor } from '@maillayers/react-email-editor';

/**
 * Example: Using the MailLayers hosted editor SDK
 *
 * The iframe bridge handles all postMessage communication automatically.
 * Just wire up callbacks for onChange / onSave / onUpload.
 */
export function EmailEditorExample() {
  const [html, setHtml] = useState('<h1>Welcome to Email Builder</h1>');
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);

  const handleChange = (html: string) => {
    console.log('Live HTML change:', html);
    setHtml(html);
  };

  const handleSave = (html: string) => {
    console.log('User clicked Save:', html);
    setLastSaved(html);
    // TODO: Send to backend API
    // await fetch('/api/templates', {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ html }),
    // });
  };

  const handleUpload = async (file: File): Promise<string> => {
    console.log('Upload requested for:', file.name);
    setUploadProgress(`Uploading ${file.name}...`);

    try {
      const formData = new FormData();
      formData.append('asset', file);

      const response = await fetch('/api/uploads', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Upload failed');
      }

      const data = await response.json();
      const url = data.url;

      setUploadProgress(null);
      console.log('Upload success, URL:', url);
      return url;
    } catch (error) {
      setUploadProgress(null);
      console.error('Upload error:', error);
      throw error;
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', flexDirection: 'column' }}>
      <header style={{ padding: '15px 20px', background: '#f5f5f5', borderBottom: '1px solid #ddd' }}>
        <h1 style={{ margin: 0, fontSize: '18px' }}>Email Builder Example</h1>
        <small style={{ color: '#666' }}>Using @maillayers/react-email-editor</small>
      </header>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        <MailLayersEmailEditor
          apiKey={process.env.NEXT_PUBLIC_MAILLAYERS_API_KEY}
          initialHtml={html}
          config={{ theme: 'light' }}
          onChange={handleChange}
          onSave={handleSave}
          onUpload={handleUpload}
          style={{ flex: 1 }}
        />
      </div>

      <footer style={{ padding: '10px 20px', background: '#fff', borderTop: '1px solid #ddd', fontSize: '12px' }}>
        {uploadProgress && <span style={{ color: '#ff9800' }}>{uploadProgress}</span>}
        {lastSaved && <span style={{ color: '#4caf50' }}>Last saved: {new Date().toLocaleTimeString()}</span>}
      </footer>
    </div>
  );
}
