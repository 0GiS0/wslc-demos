# Cómo empezar con WSL Container

Hola developer.

En este repo te dejo una guia sencilla con todos los comandos del proceso para usar wslc y levantar la demo de Spiderman en Node.js.

Primero, actualiza WSL en versión pre-release:

```pwsh
wsl --update --pre-release
```

Comprueba que wslc está disponible:

```pwsh
wslc
wslc --version
```

Si prefieres un alias corto:

```pwsh
Set-Alias container wslc
```

## Ejemplo básico con nginx

Lanza un contenedor nginx en el puerto 8080:

```pwsh
container run -p 8080:80 nginx
```

Revisa imágenes descargadas:

```pwsh
container images
```

Revisa contenedores en ejecución:

```pwsh
container ps
```

## Demo Node.js Spiderman y proceso completo

Este repo incluye una app Node.js con temática Marvel que muestra en orden las películas de Spiderman de Tom Holland.

### 1. Construir imagen con ContainerFile multi-stage

Build principal para la demo:

```pwsh
wslc build -t spiderman-demo:multistage .
```

Build alternativo de compatibilidad con el tag anterior:

```pwsh
wslc build -t spiderman-demo:latest .
```

### 1.1 Verificar que .dockerignore se aplica

Validacion sencilla con `exec` sobre el contenedor ya arrancado:

```pwsh
wslc exec spiderman-demo sh -lc "test ! -f /app/README.md && echo 'OK: README no esta en la imagen' || echo 'ERROR: README si esta en la imagen'"
```

### 2. Ejecutar contenedor

Ejecución recomendada en 8080:

```pwsh
wslc run -d -p 8080:3000 --name spiderman-demo spiderman-demo:multistage
```

Si 8080 está ocupado, ejecuta en 8081:

```pwsh
wslc run -d -p 8081:3000 --name spiderman-demo-alt spiderman-demo:multistage
```

Verifica contenedores activos:

```pwsh
wslc ps
```

Verifica logs:

```pwsh
wslc logs spiderman-demo
wslc logs spiderman-demo-alt
```

Comprobación HTTP:

```pwsh
Invoke-WebRequest -UseBasicParsing http://localhost:8080
Invoke-WebRequest -UseBasicParsing http://localhost:8081
```

### 3. Parar y limpiar contenedores

Detener contenedor:

```pwsh
wslc stop spiderman-demo
wslc stop spiderman-demo-alt
```

Eliminar contenedor:

```pwsh
wslc rm spiderman-demo
wslc rm spiderman-demo-alt
```

### 4. Resumen rápido de comandos clave

```pwsh
wsl --update --pre-release
wslc --version
wslc build -t spiderman-demo:multistage .
wslc run -d -p 8080:3000 --name spiderman-demo spiderman-demo:multistage
wslc ps
wslc logs spiderman-demo
wslc stop spiderman-demo
wslc rm spiderman-demo
```
