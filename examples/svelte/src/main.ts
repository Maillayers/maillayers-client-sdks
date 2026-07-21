import { MailLayersEmailEditor } from '@maillayers/svelte-email-editor';

const apiKey = import.meta.env.VITE_MAILLAYERS_API_KEY;
const target = document.getElementById('app');
if (target) {
  new MailLayersEmailEditor({
    target,
    props: {
      apiKey,
      initialHtml: '<h1>Svelte MailLayers Example</h1><p>Edit this template.</p>',
    },
  });
}
