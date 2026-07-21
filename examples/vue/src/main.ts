import { createApp, h, ref } from 'vue';
import { MailLayersEmailEditor } from '@maillayers/vue-email-editor';

const apiKey = import.meta.env.VITE_MAILLAYERS_API_KEY;
const editor = ref(null);

createApp({
  setup() {
    return () =>
      h(MailLayersEmailEditor, {
        ref: editor,
        apiKey,
        initialHtml: '<h1>Vue MailLayers Example</h1><p>Edit this template.</p>',
        onChange: (html: string) => {
          void html;
        },
        onReady: () => {
          void 0;
        },
        onAuthError: (message: string) => {
          void message;
        },
      });
  },
}).mount('#app');
