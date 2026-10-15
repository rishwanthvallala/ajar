import java.util.*;
import java.util.stream.*;

public class Collections1 {
    public static void main(String[] args) {
        List<String> names = new ArrayList<>(List.of("Charlie", "alice", "Bob", "dave", "Eve"));
        Collections.sort(names);
        System.out.println(names);
        names.sort(String.CASE_INSENSITIVE_ORDER);
        System.out.println(names);
        names.sort(Comparator.comparing(String::length).thenComparing(Comparator.reverseOrder()));
        System.out.println(names);
        Map<String, Integer> hm = new HashMap<>();
        for (String w : "to be or not to be that is the question".split(" ")) hm.put(w, hm.getOrDefault(w, 0) + 1);
        System.out.println(hm);
        System.out.println(new TreeMap<>(hm).descendingMap());
        Set<Integer> hs = new HashSet<>(List.of(100, 5, 33, 7, 1000, 2));
        System.out.println(hs + " " + new TreeSet<>(hs).headSet(33));
        LinkedHashMap<String, Integer> lhm = new LinkedHashMap<>();
        lhm.put("z", 1); lhm.put("a", 2); lhm.put("m", 3);
        System.out.println(lhm + " " + lhm.keySet() + " " + lhm.values());
        Deque<Integer> dq = new ArrayDeque<>();
        dq.push(1); dq.addLast(2); dq.offerFirst(0);
        System.out.println(dq + " " + dq.peekLast() + " " + dq.pop());
        PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[1] - b[1]);
        pq.add(new int[]{1, 30}); pq.add(new int[]{2, 10}); pq.add(new int[]{3, 20});
        StringBuilder order = new StringBuilder();
        while (!pq.isEmpty()) order.append(pq.poll()[0]);
        System.out.println("pq order " + order);
        int[] arr = {5, 2, 9, 1, 5, 6};
        Arrays.sort(arr);
        System.out.println(Arrays.toString(arr) + " " + Arrays.binarySearch(arr, 6) + " " + Arrays.stream(arr).sum());
        int[][] grid = new int[3][4];
        grid[1][2] = 7;
        System.out.println(Arrays.deepToString(grid));
        Integer[] boxed = {3, 1, 2};
        Arrays.sort(boxed, Collections.reverseOrder());
        System.out.println(Arrays.asList(boxed));
        System.out.println(IntStream.rangeClosed(1, 10).filter(i -> i % 2 == 0).boxed().collect(Collectors.toList()));
        System.out.println(Stream.of("a", "bb", "cc", "ddd").collect(Collectors.groupingBy(String::length)));
        System.out.println(Stream.of("x", "y", "z").collect(Collectors.joining(", ", "[", "]")));
        System.out.println(names.stream().map(String::toUpperCase).sorted().reduce("", (a, b) -> a + b.charAt(0)));
        System.out.println(Stream.iterate(1, x -> x * 3).limit(6).mapToInt(Integer::intValue).summaryStatistics());
        Map<Boolean, Long> parts = IntStream.range(0, 20).boxed().collect(Collectors.partitioningBy(i -> i > 14, Collectors.counting()));
        System.out.println(parts);
        Optional<String> longest = names.stream().max(Comparator.comparingInt(String::length));
        System.out.println(longest.orElse("none") + " " + Optional.empty().isPresent());
        Iterator<String> it = names.iterator();
        while (it.hasNext()) if (it.next().startsWith("B")) it.remove();
        System.out.println(names + " " + names.contains("dave") + " " + names.indexOf("Eve"));
        List<Integer> nums = IntStream.range(0, 10).boxed().collect(Collectors.toCollection(ArrayList::new));
        Collections.shuffle(nums, new Random(42));
        System.out.println(nums + " " + Collections.max(nums) + " " + Collections.frequency(nums, 3));
        EnumMap<Day, String> em = new EnumMap<>(Day.class);
        em.put(Day.WED, "mid"); em.put(Day.MON, "start");
        System.out.println(em + " " + Day.valueOf("TUE").ordinal() + " " + Arrays.toString(Day.values()));
    }
    enum Day { MON, TUE, WED }
}
