/**
 * Home's stack, without a header: Home draws its own title and scroll edge (C01, C02). In a native
 * stack, with its scroll view as the page's root, UIKit finds that scroll view and minimizes the
 * tab bar as it scrolls.
 */
import { Stack } from "expo-router";

export default function HomeLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
