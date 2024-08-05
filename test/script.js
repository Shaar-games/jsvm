
        // Affiche des informations sur la taille de la fenêtre
        function displayWindowSize() {
            var widthInfo = 'Largeur de la fenêtre : ' + window.innerWidth + 'px';
            var heightInfo = 'Hauteur de la fenêtre : ' + window.innerHeight + 'px';
            console.log(widthInfo);
            console.log(heightInfo);
            return 'Largeur: ' + window.innerWidth + 'px, Hauteur: ' + window.innerHeight + 'px';
        }

        // Affiche l'URL actuelle
        function displayCurrentURL() {
            var urlInfo = 'URL actuelle : ' + window.location.href;
            console.log(urlInfo);
            return urlInfo;
        }

        // Affiche l'historique de navigation
        function showHistoryLength() {
            var historyInfo = 'Longueur de l\'historique : ' + window.history.length;
            console.log(historyInfo);
            return historyInfo;
        }

        // Ouvre une nouvelle fenêtre
        function openNewWindow() {
            console.log("Ouverture d'une nouvelle fenêtre");
            var newWindow = window.open('https://www.example.com', '_blank', 'width=600,height=400');
            if (newWindow) {
                newWindow.focus();
            }
        }

        // Alarme simple avec setTimeout
        function showAlertAfterDelay() {
            window.setTimeout(function() {
                alert("Ceci est une alerte après un délai de 3 secondes !");
            }, 3000);
        }

        // Stockage de données avec localStorage
        function saveToLocalStorage() {
            window.localStorage.setItem('username', 'Jean Dupont');
            console.log('Nom utilisateur sauvegardé dans localStorage');
        }

        function getFromLocalStorage() {
            var username = window.localStorage.getItem('username');
            var userInfo = 'Nom utilisateur : ' + username;
            console.log(userInfo);
            return userInfo;
        }

        // Met à jour le contenu de la page avec les informations récupérées
        function updatePageContent() {
            var infoElement = document.getElementById('infoDisplay');
            infoElement.innerHTML = 
                '<h3>Informations sur la fenêtre</h3>' +
                '<p>' + displayWindowSize() + '</p>' +
                '<p>' + displayCurrentURL() + '</p>' +
                '<p>' + showHistoryLength() + '</p>' +
                '<p>' + getFromLocalStorage() + '</p>';
        }

        // Fonction principale qui exécute toutes les actions
        function main() {
            updatePageContent();
            saveToLocalStorage();
            openNewWindow();
            showAlertAfterDelay();
        }

        main();