# 🐧 Contenedores Linux nativos en Windows: probando WSL Container

<div align="center">

[![YouTube Channel Subscribers](https://img.shields.io/youtube/channel/subscribers/UC140iBrEZbOtvxWsJ-Tb0lQ?style=for-the-badge&logo=youtube&logoColor=white&color=red)](https://www.youtube.com/c/GiselaTorres?sub_confirmation=1)
[![GitHub followers](https://img.shields.io/github/followers/0GiS0?style=for-the-badge&logo=github&logoColor=white)](https://github.com/0GiS0)
[![LinkedIn Follow](https://img.shields.io/badge/LinkedIn-Sígueme-blue?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/giselatorresbuitrago/)
[![X Follow](https://img.shields.io/badge/X-Sígueme-black?style=for-the-badge&logo=x&logoColor=white)](https://twitter.com/0GiS0)

</div>

---

¡Hola developer 👋🏻! Este repositorio contiene una demo práctica para aprender a usar **WSL Container (wslc)**, la nueva forma de ejecutar contenedores Linux de forma nativa en Windows sin necesidad de Docker Desktop. Incluye una aplicación Node.js con temática Marvel que muestra la trilogía de Spider-Man de Tom Holland.

<a href="https://youtu.be/7Mmt35ga7xM">
  <img src="https://img.youtube.com/vi/7Mmt35ga7xM/maxresdefault.jpg" alt="🐧 Contenedores Linux nativos en Windows: probando WSL Container" width="100%" />
</a>

---

## 📑 Tabla de Contenidos
- [Características](#-características)
- [Tecnologías](#️-tecnologías-utilizadas)
- [Requisitos Previos](#-requisitos-previos)
- [Instalación](#-instalación)
- [Uso](#-uso)
- [Estructura del Proyecto](#-estructura-del-proyecto)
- [Sígueme](#-sígueme-en-mis-redes-sociales)

---

## ✨ Características
- Ejecución de contenedores Linux nativos en Windows con `wslc`
- Build multi-stage optimizado para producción
- Aplicación web Node.js con Express
- Interfaz visual estilo Marvel con la saga de Spider-Man
- Configuración de `.dockerignore` para imágenes más ligeras
- Comandos compatibles con la sintaxis de Docker

---

## 🛠️ Tecnologías Utilizadas
- **WSL Container (wslc)** - Motor de contenedores nativo de Windows
- **Node.js 20 Alpine** - Runtime JavaScript
- **Express.js** - Framework web minimalista
- **HTML5 + CSS3** - Interfaz de usuario con diseño Marvel

---

## 📋 Requisitos Previos
- Windows 10/11 con WSL habilitado
- WSL versión pre-release (para acceso a wslc)
- PowerShell o Windows Terminal

---

## 🚀 Instalación

### Paso 1: Actualizar WSL a versión pre-release
```pwsh
wsl --update --pre-release
```

### Paso 2: Verificar que wslc está disponible
```pwsh
wslc --version
```

> **Nota:** Si prefieres un alias más corto, puedes configurarlo así:
> ```pwsh
> Set-Alias container wslc
> ```

### Paso 3: Clonar el repositorio
```pwsh
git clone https://github.com/0GiS0/wslc-demos.git
cd wslc-demos
```

### Paso 4: Construir la imagen
```pwsh
wslc build -t spiderman-demo:multistage .
```

### Paso 5: Ejecutar el contenedor
```pwsh
wslc run -d -p 8080:3000 --name spiderman-demo spiderman-demo:multistage
```

---

## 💻 Uso

### Ejemplo básico con nginx
Lanza un contenedor nginx en el puerto 8080:
```pwsh
wslc run -p 8080:80 nginx
```

### Comandos útiles de wslc
```pwsh
# Ver imágenes descargadas
wslc images

# Ver contenedores en ejecución
wslc ps

# Ver logs del contenedor
wslc logs spiderman-demo

# Detener un contenedor
wslc stop spiderman-demo

# Eliminar un contenedor
wslc rm spiderman-demo
```

### Verificar que .dockerignore funciona
```pwsh
wslc exec spiderman-demo sh -lc "test ! -f /app/README.md && echo 'OK: README no está en la imagen' || echo 'ERROR: README sí está en la imagen'"
```

### Comprobación HTTP
```pwsh
Invoke-WebRequest -UseBasicParsing http://localhost:8080
```

---

## 📁 Estructura del Proyecto
```
wslc-demos/
├── src/
│   ├── app.js              # Servidor Express
│   └── public/
│       ├── index.html      # Interfaz Spider-Man
│       └── styles.css      # Estilos Marvel
├── .devcontainer/          # Configuración Dev Container
├── .dockerignore           # Archivos excluidos del build
├── ContainerFile           # Multi-stage build definition
├── package.json            # Dependencias Node.js
└── README.md
```

---

## 🌐 Sígueme en Mis Redes Sociales

Si te ha gustado este proyecto y quieres ver más contenido como este, no olvides suscribirte a mi canal de YouTube y seguirme en mis redes sociales:

<div align="center">

[![YouTube Channel Subscribers](https://img.shields.io/youtube/channel/subscribers/UC140iBrEZbOtvxWsJ-Tb0lQ?style=for-the-badge&logo=youtube&logoColor=white&color=red)](https://www.youtube.com/c/GiselaTorres?sub_confirmation=1)
[![GitHub followers](https://img.shields.io/github/followers/0GiS0?style=for-the-badge&logo=github&logoColor=white)](https://github.com/0GiS0)
[![LinkedIn Follow](https://img.shields.io/badge/LinkedIn-Sígueme-blue?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/giselatorresbuitrago/)
[![X Follow](https://img.shields.io/badge/X-Sígueme-black?style=for-the-badge&logo=x&logoColor=white)](https://twitter.com/0GiS0)

</div>
