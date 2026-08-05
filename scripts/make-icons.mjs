import { existsSync } from "fs";

const requiredIcons = [
  "public/icons/icon.png",
  "public/icons/icon@2x.png",
  "public/icons/dark.png",
  "public/icons/dark@2x.png",
  "public/icons/light.png",
  "public/icons/light@2x.png",
];

if (requiredIcons.some((path) => !existsSync(path))) {
  throw new Error("Missing checked-in icon assets under public/icons/");
}

console.log("icons -> public/icons/ (checked-in assets)");
