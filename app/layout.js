import "./globals.css";

export const metadata = {
  title: "ASCII Steam Generator",
  description: "Convertir une photo en art ASCII compatible commentaires Steam."
};

export default function RootLayout({ children }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}

