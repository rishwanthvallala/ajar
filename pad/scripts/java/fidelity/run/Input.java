import java.util.*;

public class Input {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        System.out.print("How many numbers? ");
        int n = sc.nextInt();
        long total = 0;
        List<Integer> xs = new ArrayList<>();
        for (int i = 0; i < n; i++) { int v = sc.nextInt(); xs.add(v); total += v; }
        sc.nextLine();
        System.out.print("Your name? ");
        String name = sc.nextLine();
        double d = sc.nextDouble();
        String word = sc.next();
        System.out.println();
        System.out.println("Hi " + name + ", sum=" + total + " max=" + Collections.max(xs) + " d*2=" + d * 2 + " word=" + word);
        while (sc.hasNextLine()) { String line = sc.nextLine(); if (!line.isEmpty()) System.out.println("extra: " + line); }
    }
}
