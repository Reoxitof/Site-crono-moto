# 🏍️ Motocross Chrono

Application web de chronométrage de sprints motocross.

## Fonctionnalités

- 10 participants avec nom et couleur personnalisables
- 3 sprints par participant (configurable)
- Mode départ automatique (toutes les 320s) ou manuel
- Boutons Départ / Arrivée / Tombé (DNF) par participant
- Classement général en temps réel

## Démarrage local

```bash
npm install
npm start
```

Ouvrir [http://localhost:3000](http://localhost:3000)

## Déploiement Sliplane

1. Pusher ce repo sur GitHub
2. Créer un nouveau service sur [Sliplane](https://sliplane.io)
3. Connecter le repo GitHub
4. Sliplane détecte le `Dockerfile` automatiquement
5. Deploy 🚀
