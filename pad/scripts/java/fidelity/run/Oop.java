import java.util.*;
import java.util.function.*;

public class Oop {
    interface Shape { double area(); default String describe() { return getClass().getSimpleName() + " with area " + String.format("%.2f", area()); } }
    record Circle(double r) implements Shape { public double area() { return Math.PI * r * r; } }
    record Rect(double w, double h) implements Shape { public double area() { return w * h; } }
    sealed interface Expr permits Num, Add, Mul {}
    record Num(int v) implements Expr {}
    record Add(Expr l, Expr r) implements Expr {}
    record Mul(Expr l, Expr r) implements Expr {}
    static int eval(Expr e) {
        return switch (e) {
            case Num n -> n.v();
            case Add(Expr l, Expr r) -> eval(l) + eval(r);
            case Mul(Expr l, Expr r) -> eval(l) * eval(r);
        };
    }
    static abstract class Animal {
        protected final String name;
        Animal(String name) { this.name = name; }
        abstract String sound();
        @Override public String toString() { return name + " says " + sound(); }
    }
    static class Dog extends Animal { Dog() { super("Dog"); } String sound() { return "woof"; } }
    static class Cat extends Animal { Cat() { super("Cat"); } String sound() { return "meow"; } }
    static class Counter { private int count; void inc() { count++; } int get() { return count; } }
    static <T extends Comparable<T>> T maxOf(List<T> xs) { T best = xs.get(0); for (T x : xs) if (x.compareTo(best) > 0) best = x; return best; }
    static int sum(int... xs) { int t = 0; for (int x : xs) t += x; return t; }
    public static void main(String[] args) {
        List<Shape> shapes = List.of(new Circle(1), new Rect(2, 3));
        for (Shape s : shapes) System.out.println(s.describe() + " " + s);
        System.out.println(eval(new Add(new Num(2), new Mul(new Num(3), new Num(4)))));
        List<Animal> zoo = List.of(new Dog(), new Cat());
        zoo.forEach(System.out::println);
        Object o = 42;
        if (o instanceof Integer i && i > 40) System.out.println("big int " + (i + 1));
        String kind = switch (o.getClass().getSimpleName()) { case "Integer" -> "int"; case "String" -> "str"; default -> "other"; };
        System.out.println(kind);
        Counter c = new Counter();
        Runnable r = c::inc;
        for (int i = 0; i < 5; i++) r.run();
        System.out.println("count " + c.get());
        Function<Integer, Integer> twice = x -> x * 2;
        Function<Integer, Integer> plus3 = x -> x + 3;
        System.out.println(twice.andThen(plus3).apply(5) + " " + twice.compose(plus3).apply(5));
        BiFunction<String, Integer, String> rep = String::repeat;
        Supplier<List<String>> sup = ArrayList::new;
        List<String> made = sup.get(); made.add(rep.apply("ab", 2));
        System.out.println(made + " " + maxOf(List.of(3, 9, 4)) + " " + maxOf(List.of("pear", "apple")) + " " + sum() + " " + sum(1, 2, 3));
        System.out.println(new Circle(2).equals(new Circle(2)) + " " + new Circle(2).hashCode() + " " + new Rect(1, 2));
        Object anon = new Object() { @Override public String toString() { return "anonymous"; } };
        System.out.println(anon);
        int x = 0;
        outer:
        for (int i = 0; i < 5; i++) for (int j = 0; j < 5; j++) { if (i * j > 6) break outer; x += j; }
        System.out.println("labeled " + x);
        long big = Integer.MAX_VALUE; big++;
        int overflow = Integer.MAX_VALUE; overflow++;
        System.out.println(big + " " + overflow + " " + (7 / 2) + " " + (-7 / 2) + " " + (-7 % 3) + " " + Math.floorMod(-7, 3) + " " + (5 >> 1) + " " + (-16 >>> 28) + " " + (6 & 3) + " " + (6 ^ 3));
        System.out.println(Objects.hash(1, "a") + " " + Objects.equals(null, null) + " " + Objects.requireNonNullElse(null, "dflt"));
    }
}
