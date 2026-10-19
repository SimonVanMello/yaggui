// Strings of the landing page, one table per locale (`en` fixes the keys, `fr` must match).
// Values are static, trusted text: those holding <kbd> or <code> are rendered with `set:html`.
// `<kbd class="mod">⌘</kbd>` is the Command key on macOS and shows as Ctrl elsewhere.
import type { Locale } from '../lib/docs-versions';

const mod = '<kbd class="mod">⌘</kbd>';

const en = {
  title: 'yaggui: the Git client that keeps up',
  description:
    'yaggui is a fast, native Git client for macOS, Windows and Linux: a smooth commit graph, line-by-line staging, visual interactive rebase and undo. Free and open source.',

  'hero.title': 'The Git client that keeps up.',
  'hero.lead':
    'yaggui is a fast, native Git client for macOS, Windows and Linux. A smooth commit graph, staging line by line, and undo for almost everything.',
  'hero.docs': 'Read the docs',
  'hero.fine': 'Free and open source',
  'hero.demo': 'Try it in your browser',
  'hero.also': 'Also on <a href="#downloads">Homebrew</a> and <a href="#downloads">AUR</a>',
  'hero.alt': 'yaggui commit graph with the commit details panel',

  'proof.fps': '<b>60 fps</b>budget when scrolling 1.3M commits',
  'proof.open': '<b>&lt; 300 ms</b>budget to the first graph screen',
  'proof.privacy': '<b>0</b>accounts, trackers or telemetry',
  'proof.label': 'Performance budgets and privacy',

  'features.kicker': 'Features',
  'features.title': 'Everything you do in Git, one gesture away.',
  'features.sub': `Checkout is a double-click. Merge is a drag. Staging is <kbd>Space</kbd>. The rest is in the palette, behind ${mod}<kbd>K</kbd>.`,
  'features.staging.title': 'Stage files, hunks or lines',
  'features.staging.text': `Select lines in the unified or split diff and press <kbd>Space</kbd>. Commit with ${mod}<kbd>↵</kbd>.`,
  'features.staging.alt': 'Line staging in the side-by-side diff',
  'features.rebase.title': 'Interactive rebase you can see',
  'features.rebase.text':
    'Reorder by drag or keyboard, squash, reword and drop, with a preview before anything runs.',
  'features.rebase.pick': 'pick',
  'features.rebase.squash': 'squash',
  'features.rebase.reword': 'reword',
  'features.rebase.drop': 'drop',
  'features.graph.title': 'A graph that scrolls Linux',
  'features.graph.text':
    'Drawn on canvas and paginated, so even the kernel history stays smooth. Drag a branch onto another to merge or rebase.',
  'features.merge.title': '3-way merge editor',
  'features.merge.text': 'Ours and theirs side by side, block checkboxes and an editable result.',
  'features.terminal.title': 'Terminal and palette',
  'features.terminal.text':
    'An integrated terminal, rebindable shortcuts, and a palette that searches everything.',

  'undo.kicker': 'Undo',
  'undo.title': `Made a mistake? Press ${mod}<kbd>Z</kbd>.`,
  'undo.sub':
    'yaggui records what each operation changes and puts the repository back the way it was.',
  'undo.check1': 'Commit, amend, checkout, reset, discard',
  'undo.check2': 'Branch creation, deletion and rename',
  'undo.check3': 'Merge (before it is pushed), cherry-pick, revert, stash drop',
  'undo.check4': 'Push is flagged as not undoable',
  'undo.mock.undo': '↶ Undo',
  'undo.mock.history': 'Session history',
  'undo.mock.row1': 'Commit “fix(graph): merge edges”',
  'undo.mock.row2': 'Reset main to 024bec7 (hard)',
  'undo.mock.row3': 'Delete branch feat/palette-31',
  'undo.mock.row4': 'Checkout feat/graph-lanes',
  'undo.mock.toast': 'Undone: commit “fix(graph): merge edges”',
  'undo.mock.redo': 'Redo',

  'local.kicker': 'Local and transparent',
  'local.title': 'Your git, doing the work.',
  'local.sub':
    'Every write goes through the <code>git</code> you already have, so your config, hooks and credentials just work. Each command lands in the log with its output.',
  'local.check1': 'No account, no telemetry',
  'local.check2': '<code>--force-with-lease</code> only, refused by default on protected branches',
  'local.check3': 'Destructive actions show their effect first',
  'local.log.label': 'Example of the command log',
  'local.log.title': 'Log',

  'themes.kicker': 'Themes',
  'themes.title': 'Graphite and Paper.',
  'themes.sub':
    'A dark theme and a light one designed together, plus high contrast and Terminal. English and French.',
  'themes.dark': 'Graphite',
  'themes.darkKind': 'Dark',
  'themes.darkAlt': 'yaggui in the Graphite theme',
  'themes.light': 'Paper',
  'themes.lightKind': 'Light',
  'themes.lightAlt': 'yaggui in the Paper theme',

  'faq.kicker': 'FAQ',
  'faq.title': 'Questions',
  'faq.q1': 'Is yaggui free?',
  'faq.a1':
    'Yes. It is open source under the GPL-3.0-or-later license, with no paid tier and no account.',
  'faq.q2': 'Does it work with my existing Git setup?',
  'faq.a2':
    'Writes go through your own <code>git</code> binary (2.30 or later), so your config, hooks, SSH keys and credential helpers apply as usual.',
  'faq.q3': 'Why does macOS or Windows warn me on first launch?',
  'faq.a3':
    'The builds are not signed or notarized yet. On macOS, clear the quarantine flag or allow the app in Privacy &amp; Security; on Windows, confirm the SmartScreen prompt.',
  'faq.q4': 'Does it collect any data?',
  'faq.a4':
    'No. There is no telemetry. Avatars from Gravatar and update checks are opt-in and off by default.',
  'faq.q5': 'How is it built?',
  'faq.a5':
    'With Tauri and Rust. The code is written by Claude through Claude Code; a human sets the direction, reviews each pull request and tests the app.',

  'cta.title': 'Give your history a better view.',
  'cta.sub': 'Free, open source and ready in a minute. In-app updates are optional.',
  'cta.others': 'Windows · Linux · other',

  'dl.title': 'All downloads',
  'dl.version': 'Version {version}',
  'dl.notes': 'Release notes',
  'dl.signing': 'The builds are not signed yet: see the FAQ.',
  'dl.macos': 'macOS',
  'dl.macosArm': 'Apple Silicon (.dmg)',
  'dl.macosX64': 'Intel (.dmg)',
  'dl.windows': 'Windows',
  'dl.windowsExe': 'Installer (.exe)',
  'dl.windowsMsi': 'MSI package (.msi)',
  'dl.linux': 'Linux',
  'dl.linuxAppImage': 'AppImage',
  'dl.linuxDeb': 'Debian, Ubuntu (.deb)',
  'dl.linuxRpm': 'Fedora, openSUSE (.rpm)',
  'dl.packages': 'Package managers',
  'dl.homebrew': 'Homebrew (macOS)',
  'dl.aur': 'Arch Linux (AUR)',
  'dl.aurLink': 'yaggui-bin on the AUR',
  'copy.copy': 'Copy',
  'copy.done': 'Copied',
  'copy.label': 'Copy the command',
};

type Strings = typeof en;

const fr: Strings = {
  title: 'yaggui : le client Git qui suit le rythme',
  description:
    'yaggui est un client Git rapide et natif pour macOS, Windows et Linux : un graphe de commits fluide, l’indexation ligne par ligne, le rebase interactif visuel et l’annulation. Libre et gratuit.',

  'hero.title': 'Le client Git qui suit le rythme.',
  'hero.lead':
    'yaggui est un client Git rapide et natif pour macOS, Windows et Linux. Un graphe de commits fluide, l’indexation ligne par ligne et l’annulation pour presque tout.',
  'hero.docs': 'Lire la documentation',
  'hero.fine': 'Libre et gratuit',
  'hero.demo': 'L’essayer dans le navigateur',
  'hero.also': 'Aussi sur <a href="#downloads">Homebrew</a> et l’<a href="#downloads">AUR</a>',
  'hero.alt': 'Le graphe de commits de yaggui avec le panneau de détails du commit',

  'proof.fps': '<b>60 fps</b>visés en parcourant 1,3 M de commits',
  'proof.open': '<b>&lt; 300 ms</b>visés avant le premier écran du graphe',
  'proof.privacy': '<b>0</b>compte, traceur ou télémétrie',
  'proof.label': 'Budgets de performance et vie privée',

  'features.kicker': 'Fonctionnalités',
  'features.title': 'Tout ce que vous faites avec Git, à un geste.',
  'features.sub': `Le checkout, c’est un double-clic. La fusion, un glisser-déposer. L’indexation, <kbd>Espace</kbd>. Le reste est dans la palette, derrière ${mod}<kbd>K</kbd>.`,
  'features.staging.title': 'Indexez des fichiers, des blocs ou des lignes',
  'features.staging.text': `Sélectionnez des lignes dans le diff unifié ou côte à côte, puis appuyez sur <kbd>Espace</kbd>. Validez avec ${mod}<kbd>↵</kbd>.`,
  'features.staging.alt': 'Indexation de lignes dans le diff côte à côte',
  'features.rebase.title': 'Un rebase interactif que l’on voit',
  'features.rebase.text':
    'Réordonnez au glisser-déposer ou au clavier, fusionnez (squash), reformulez et supprimez, avec un aperçu avant toute exécution.',
  'features.rebase.pick': 'pick',
  'features.rebase.squash': 'squash',
  'features.rebase.reword': 'reword',
  'features.rebase.drop': 'drop',
  'features.graph.title': 'Un graphe qui défile sur Linux',
  'features.graph.text':
    'Dessiné sur un canvas et paginé : même l’historique du noyau reste fluide. Glissez une branche sur une autre pour la fusionner ou la rebaser.',
  'features.merge.title': 'Éditeur de fusion à 3 volets',
  'features.merge.text':
    'Votre version et la leur côte à côte, cases à cocher par bloc et résultat modifiable.',
  'features.terminal.title': 'Terminal et palette',
  'features.terminal.text':
    'Un terminal intégré, des raccourcis reconfigurables et une palette qui cherche partout.',

  'undo.kicker': 'Annulation',
  'undo.title': `Une erreur ? Appuyez sur ${mod}<kbd>Z</kbd>.`,
  'undo.sub':
    'yaggui enregistre ce que chaque opération modifie et remet le dépôt dans l’état où il était.',
  'undo.check1': 'Commit, amend, checkout, reset, abandon de modifications',
  'undo.check2': 'Création, suppression et renommage de branches',
  'undo.check3': 'Fusion (avant son envoi), cherry-pick, revert, suppression d’un stash',
  'undo.check4': 'Le push est signalé comme non annulable',
  'undo.mock.undo': '↶ Annuler',
  'undo.mock.history': 'Historique de la session',
  'undo.mock.row1': 'Commit « fix(graph): merge edges »',
  'undo.mock.row2': 'Reset de main sur 024bec7 (hard)',
  'undo.mock.row3': 'Suppression de la branche feat/palette-31',
  'undo.mock.row4': 'Checkout de feat/graph-lanes',
  'undo.mock.toast': 'Annulé : commit « fix(graph): merge edges »',
  'undo.mock.redo': 'Rétablir',

  'local.kicker': 'Local et transparent',
  'local.title': 'Votre git fait le travail.',
  'local.sub':
    'Chaque écriture passe par le <code>git</code> déjà installé : votre configuration, vos hooks et vos identifiants fonctionnent tels quels. Chaque commande est consignée dans le journal avec sa sortie.',
  'local.check1': 'Pas de compte, pas de télémétrie',
  'local.check2':
    '<code>--force-with-lease</code> uniquement, refusé par défaut sur les branches protégées',
  'local.check3': 'Les actions destructrices montrent d’abord leur effet',
  'local.log.label': 'Exemple de journal des commandes',
  'local.log.title': 'Journal',

  'themes.kicker': 'Thèmes',
  'themes.title': 'Graphite et Paper.',
  'themes.sub':
    'Un thème sombre et un thème clair conçus ensemble, plus un contraste élevé et Terminal. En français et en anglais.',
  'themes.dark': 'Graphite',
  'themes.darkKind': 'Sombre',
  'themes.darkAlt': 'yaggui avec le thème Graphite',
  'themes.light': 'Paper',
  'themes.lightKind': 'Clair',
  'themes.lightAlt': 'yaggui avec le thème Paper',

  'faq.kicker': 'FAQ',
  'faq.title': 'Questions',
  'faq.q1': 'yaggui est-il gratuit ?',
  'faq.a1': 'Oui. Il est open source, sous licence GPL-3.0-or-later, sans offre payante ni compte.',
  'faq.q2': 'Fonctionne-t-il avec ma configuration Git existante ?',
  'faq.a2':
    'Les écritures passent par votre propre binaire <code>git</code> (2.30 ou plus récent) : votre configuration, vos hooks, vos clés SSH et vos assistants d’identifiants s’appliquent comme d’habitude.',
  'faq.q3': 'Pourquoi macOS ou Windows m’avertit-il au premier lancement ?',
  'faq.a3':
    'Les versions ne sont pas encore signées ni notarisées. Sur macOS, retirez l’attribut de quarantaine ou autorisez l’app dans Confidentialité et sécurité ; sur Windows, confirmez l’avertissement SmartScreen.',
  'faq.q4': 'Collecte-t-il des données ?',
  'faq.a4':
    'Non. Il n’y a aucune télémétrie. Les avatars Gravatar et la vérification des mises à jour sont optionnels et désactivés par défaut.',
  'faq.q5': 'Comment est-il construit ?',
  'faq.a5':
    'Avec Tauri et Rust. Le code est écrit par Claude via Claude Code ; un humain fixe la direction, relit chaque pull request et teste l’application.',

  'cta.title': 'Offrez à votre historique une meilleure vue.',
  'cta.sub': 'Libre, gratuit et prêt en une minute. Les mises à jour dans l’app sont optionnelles.',
  'cta.others': 'Windows · Linux · autres',

  'dl.title': 'Tous les téléchargements',
  'dl.version': 'Version {version}',
  'dl.notes': 'Notes de version',
  'dl.signing': 'Les versions ne sont pas encore signées : voir la FAQ.',
  'dl.macos': 'macOS',
  'dl.macosArm': 'Apple Silicon (.dmg)',
  'dl.macosX64': 'Intel (.dmg)',
  'dl.windows': 'Windows',
  'dl.windowsExe': 'Installateur (.exe)',
  'dl.windowsMsi': 'Paquet MSI (.msi)',
  'dl.linux': 'Linux',
  'dl.linuxAppImage': 'AppImage',
  'dl.linuxDeb': 'Debian, Ubuntu (.deb)',
  'dl.linuxRpm': 'Fedora, openSUSE (.rpm)',
  'dl.packages': 'Gestionnaires de paquets',
  'dl.homebrew': 'Homebrew (macOS)',
  'dl.aur': 'Arch Linux (AUR)',
  'dl.aurLink': 'yaggui-bin sur l’AUR',
  'copy.copy': 'Copier',
  'copy.done': 'Copié',
  'copy.label': 'Copier la commande',
};

const strings: Record<Locale, Strings> = { en, fr };

export type LandingKey = keyof Strings;

export function tl(locale: Locale, key: LandingKey, params: Record<string, string> = {}): string {
  return strings[locale][key].replace(/\{(\w+)\}/g, (m, name: string) => params[name] ?? m);
}
