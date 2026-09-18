# APK de teste Android

Este diretório existe apenas para empacotar o arquivo `stackup-holdem-teste-standalone.html`
como um APK Android de teste, sem alterar o aplicativo web principal.

O workflow copia o HTML standalone para `app/src/main/assets/index.html` no momento do build
e gera um APK debug instalável.
