# Workflow d'implementation VM / compilateur pour agent IA

Ce document decrit la methode de travail attendue pour un agent IA qui
continue l'implementation du compilateur JavaScript et de la VM bytecode de ce
projet.

Le but n'est pas seulement de faire passer des tests. L'agent doit corriger le
premier vrai bug observable, conserver l'architecture du projet, limiter les
regressions, et laisser une trace de validation reproductible.

## 1. Regles de pilotage

L'agent doit suivre ces regles pendant toute la session:

- continuer a corriger les bugs un par un tant qu'il reste un prochain echec
clair et qu'aucune aide humaine n'est necessaire
- utiliser le mode fast-fail pour trouver le premier vrai echec
- utiliser des tests cibles pour debugger un correctif
- relancer regulierement un test global fast-fail pour verifier l'absence de
regression et reveler le prochain bug
- ne pas s'arreter a une analyse si un correctif concret peut etre implemente
- ne pas lancer `npm run build` en parallele avec le runner VM/test262
- utiliser un timeout long, au minimum une heure, pour les runs globaux
- si un bug unitaire est corrige, confirmer avec:
  1. `npm run build`
  2. le ou les tests cibles
  3. un rerun global fast-fail

## 2. Architecture a respecter

L'agent ne doit pas contourner l'architecture du repo.

### Compilateur

- le vrai compilateur vit sous `compiler/`
- le point d'entree est `compiler/index.ts`
- quand c'est praticable, un type d'operation AST = un fichier dedie
- la logique partagee doit etre extraite dans un helper ou un module commun
- ne pas ajouter de wrapper racine si l'integration externe ne l'exige pas

### VM

- la vraie VM vit sous `vm/`
- le point d'entree est `vm/index.ts`
- les registres et les environnements lexicaux sont deux espaces distincts
- ne pas reintroduire l'ancienne abstraction `frame`
- les imports locaux doivent converger vers un pipeline compile puis execute par
la VM, pas un bypass permanent via l'hote

### Bytecode

- si un nouvel opcode est necessaire:
  1. l'ajouter dans `bytecode/opcodes.ts`
  2. documenter sa forme dans `docs/bytecode.md`
  3. implementer son execution cote VM avant de l'emettre largement cote
    compilateur

## 3. Strategie de correction

L'agent doit toujours partir du premier echec reel.

Ordre attendu:

1. lancer un run global fast-fail
2. prendre le premier test qui echoue vraiment
3. classifier la cause
4. corriger a la bonne couche
5. valider localement
6. relancer un global fast-fail
7. passer au prochain echec

L'agent ne doit pas ouvrir plusieurs chantiers semantiques a la fois, sauf si
plusieurs tests echouent a cause de la meme cause racine immediate.

## 4. Classification des echecs

Avant toute modification, l'agent doit identifier la categorie de bug:

- parseur: syntaxe mal acceptee ou mal rejetee
- lowering compilateur: AST supporte partiellement ou sequence bytecode
insuffisante
- contrat bytecode: il manque une instruction explicite
- execution VM: opcode existant mais semantique JavaScript incorrecte
- runtime: builtin, descripteur, coercion, espece, iterateur, proxy, module,
etc.
- harness: metadata Test262, strict mode, async completion, include, realm

La correction doit etre faite a la couche qui porte legitimement la semantique.
Il faut eviter les contournements locaux qui masquent un manque structurel.

## 5. Commandes de travail

### Build

```sh
npm run build
```

### Tests locaux

```sh
npm run test:local
```

### Test cible VM

```sh
node dist/scripts/run-test-suite.js --no-local --no-test262 --test262-vm --filter="path\\to\\test.js" --fail-fast
```

### Tranche globale VM fast-fail

```sh
node dist/scripts/run-test-suite.js --no-local --no-test262 --test262-vm --skip=17090 --limit=1000 --fail-fast
```

### Utilisation de `--skip=`

`--skip=` sert uniquement a:

- revenir rapidement au voisinage d'un bug connu
- eviter de rescanner des centaines de tests deja validés dans la tranche
courante
- debugger un test precis apres avoir confirme qu'un correctif unitaire passe

L'agent ne doit pas utiliser `--skip=` pour eviter durablement un bug. Le but
reste de faire progresser le run global.

## 6. Ordre de validation obligatoire

Pour chaque correctif:

1. modifier le code
2. lancer `npm run build`
3. lancer le test cible lie au bug
4. si le test cible passe, lancer `npm run test:local`
5. si les tests locaux passent, relancer un run global fast-fail

Le run global est obligatoire apres un correctif unitaire reussi. Un correctif
qui passe en cible mais pas en global n'est pas considere stable.

## 7. Politique de progression

L'agent doit travailler en boucle:

1. premier echec global
2. correctif minimal mais structurellement propre
3. validation cible
4. validation locale
5. validation globale
6. repetition

L'agent doit continuer tant que:

- le prochain echec est comprehensible
- le repo reste modifiable sans aide utilisateur
- les tests locaux ne regressent pas

L'agent peut s'arreter seulement si:

- il n'y a plus d'echec exploitable sans nouvelle decision produit
- un changement d'architecture important demande confirmation humaine
- un blocage externe empeche de continuer proprement

## 8. Contraintes de qualite

L'agent doit respecter ces principes:

- pas de duplication inutile entre plusieurs fichiers
- extraire la logique partagee si deux correctifs ressemblent trop
- pas de "quick fix" local si la bonne solution est un helper reutilisable
- garder les comportements explicites et testables
- ne pas cacher de semantique dans des astuces de registres
- si un comportement reste incomplet, le code doit le rendre clair

## 9. Builtins et runtime

Quand le bug touche un builtin ou un comportement runtime observable,
l'agent doit verifier:

- branding
- descripteurs de propriete
- ordre des coercions
- type d'erreur attendu
- cas `Symbol`, `BigInt`, `null`, `undefined`
- comportement realm-correct si la VM interpose
- semantique proxy / iterateur / species / relativeTo / calendar / timeZone si
la zone concernee le demande

Quand une implementation host en texte ou delegation dynamique devient trop  
fragile, l'agent doit preferer un chemin runtime explicite et partage.

## 10. Ce qui doit etre rapporte a la fin d'un tour

Si l'agent termine un tour de travail, il doit fournir un bilan concis mais
complet contenant:

- les fichiers modifies
- la zone semantique corrigee
- les tests cibles passes
- le resultat de `npm run test:local`
- le dernier resultat global fast-fail
- le prochain premier echec reel

Si l'agent estime pouvoir continuer sans aide, il doit continuer au lieu de
clore la conversation.

## 11. Resume operatoire minimal

La version courte a suivre est:

1. trouver le premier vrai echec avec fast-fail
2. corriger ce bug a la bonne couche
3. build
4. test cible
5. tests locaux
6. fast-fail global
7. repeter sans s'arreter

Tant qu'il reste des chose a implémenter/corriger, l'agent doit continuer.  
  
## 12. Documentation

Gardez la Documentation a jour dans docs/*